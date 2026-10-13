// Codex 派工桥 v2 —— 执行引擎
//
// 相对 v1 的协同增强：
//   1. 软预算：接近 maxSteps/timeout 时先发 steer 让执行者收尾，而不是硬中断；
//   2. 中途干预：Codex 可用 steer 向运行中的会话注入指令；
//   3. 结构化交付：result.json + evidence.json + journal.ndjson，审查不必读 MB 级事件；
//   4. 实时进度：progress.json + health 槽位 + 长轮询 watch；
//   5. 提问/回答：outcome=needs_input 时挂起，Codex 回答后在同一会话续跑；
//   6. 返工续跑：repair/resume 优先复用同一会话，其次 fork，最后才冷启动并带摘要；
//   7. 并发与依赖：最多 maxConcurrent 个会话并行，dependsOn 组成 DAG。

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BRIDGE_VERSION, DEFAULT_ROOT, REVIEWABLE_STATES,
  activeSessions, atomicJson, canonicalPathSync, collectEvidence, isTerminal, jobDir, loadConfig, nowIso,
  parseBridgeResult, promptFor, readJson, resultMeta, truncate,
  touchedFiles, commandOf, validateTask, validId,
} from './protocol.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ACTIVE_STATES = new Set(['queued', 'running']);
const RESUMABLE_STATES = new Set(['needs_input', 'completed', 'step_limit', 'timeout', 'failed', 'interrupted', 'blocked']);
const EVENT_LOG_TYPES = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message', 'approval/asked', 'approval/decided']);

export async function startBridge(ctx, root = DEFAULT_ROOT, pollMsOverride = undefined) {
  const config = await loadConfig(root);
  const pollMs = Number.isInteger(pollMsOverride) ? pollMsOverride : config.pollMs;
  for (const name of ['inbox', 'jobs']) await fs.mkdir(path.join(root, name), { recursive: true, mode: 0o700 });
  await ensureToken(root);

  let stopped = false, scanning = false, timer;
  const lockPath = path.join(root, 'worker.lock');
  // One worker per queue; a dead process lock may be reclaimed.
  try {
    const old = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    try { process.kill(old.pid, 0); throw new Error(`Bridge already running in PID ${old.pid}`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await fs.unlink(lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = await fs.open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, version: BRIDGE_VERSION })); await lock.close();

  const active = new Map();       // jobId -> handle
  const handles = new Map();      // every live handle, for event routing
  const sessionIndex = new Map(); // sessionId -> jobId

  await recoverInterrupted();

  const offSessionEvent = typeof ctx.on === 'function'
    ? ctx.on('session/event', (session, event) => {
      const jobId = session?.id === undefined ? undefined : sessionIndex.get(session.id);
      const handle = jobId === undefined ? undefined : handles.get(jobId);
      if (handle) handle.ingest(event);
    })
    : undefined;

  // ---------------------------------------------------------------- 恢复
  async function recoverInterrupted() {
    for (const id of (await fs.readdir(path.join(root, 'jobs')).catch(() => [])).filter(validId)) {
      const file = path.join(jobDir(root, id), 'status.json');
      try {
        const job = JSON.parse(await fs.readFile(file, 'utf8'));
        if (job.state === 'running') {
          job.state = 'interrupted';
          job.error = 'Worker stopped mid-turn. Inspect the session and files, then use `resume ID` (same session) or `repair ID NOTE`; the task is never replayed automatically.';
          job.finishedAt = nowIso();
          await atomicJson(file, job);
        }
      } catch (error) { ctx.logger.warn(`bridge recovery ${id}: ${String(error)}`); }
    }
  }

  async function pendingSignals(id) {
    const dir = jobDir(root, id);
    const resume = await readJson(path.join(dir, 'resume'), null).catch(() => null);
    const answers = [];
    for (const name of (await fs.readdir(path.join(dir, 'answer')).catch(() => [])).filter(v => v.endsWith('.json')).sort()) {
      const value = await readJson(path.join(dir, 'answer', name), null).catch(() => null);
      if (value) answers.push(value);
    }
    return { resume, answers };
  }

  async function consumeSignals(id) {
    const dir = jobDir(root, id);
    const signals = await pendingSignals(id);
    await fs.unlink(path.join(dir, 'resume')).catch(() => {});
    for (const name of (await fs.readdir(path.join(dir, 'answer')).catch(() => [])).filter(v => v.endsWith('.json'))) {
      await fs.unlink(path.join(dir, 'answer', name)).catch(() => {});
    }
    return signals;
  }

  // ---------------------------------------------------------------- 健康
  async function publishHealth() {
    const waitingInput = [];
    let queued = (await fs.readdir(path.join(root, 'inbox')).catch(() => [])).filter(name => name.endsWith('.json')).length;
    let blocked = 0;
    for (const id of (await fs.readdir(path.join(root, 'jobs')).catch(() => [])).filter(validId)) {
      const status = await readJson(path.join(jobDir(root, id), 'status.json'), null).catch(() => null);
      if (!status) continue;
      if (status.state === 'needs_input') waitingInput.push({ id, questions: status.questions ?? [] });
      // Admission reserves an active slot before async startup persists "running".
      // Avoid counting that same job as queued while the disk state catches up.
      if (status.state === 'queued' && !active.has(id)) queued++;
      if (status.state === 'blocked') blocked++;
    }
    await atomicJson(path.join(root, 'health.json'), {
      version: BRIDGE_VERSION,
      pid: process.pid,
      updatedAt: nowIso(),
      maxConcurrent: config.maxConcurrent,
      activeCount: active.size,
      activeTasks: [...active.values()].map(handle => ({ id: handle.job.id, state: 'running', attempt: handle.attempt, step: handle.steps, maxSteps: handle.task.maxSteps, sessionId: handle.sessionId ?? null })),
      queued, blocked, waitingInput,
      queuedIds: (await fs.readdir(path.join(root, 'inbox')).catch(() => [])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)),
      queueDir: root,
    });
  }

  // ---------------------------------------------------------------- 调度
  async function tick() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      await publishHealth();
      await resumeSignalledJobs();
      await retryBlockedJobs();
      await startInboxJobs();
    } catch (error) { ctx.logger.warn(`bridge scan: ${String(error)}`); }
    finally { scanning = false; }
  }

  async function loadJob(id) {
    const dir = jobDir(root, id);
    const status = await readJson(path.join(dir, 'status.json'), null).catch(() => null);
    const task = await readJson(path.join(dir, 'task.json'), null).catch(() => null);
    return { status, task };
  }

  async function resumeSignalledJobs() {
    for (const id of (await fs.readdir(path.join(root, 'jobs')).catch(() => [])).filter(validId)) {
      if (active.has(id) || active.size >= config.maxConcurrent) continue;
      const { status, task } = await loadJob(id);
      if (!status || !task || ACTIVE_STATES.has(status.state) || !RESUMABLE_STATES.has(status.state)) continue;
      const { resume, answers } = await pendingSignals(id);
      if (!resume && !answers.length) continue;
      const signals = await consumeSignals(id);
      startJob(task, status, signals);
    }
  }

  async function retryBlockedJobs() {
    for (const id of (await fs.readdir(path.join(root, 'jobs')).catch(() => [])).filter(validId)) {
      if (active.has(id) || active.size >= config.maxConcurrent) continue;
      const { status, task } = await loadJob(id);
      if (!status || !task) continue;
      if (!['blocked', 'queued'].includes(status.state)) continue;
      if (!(task.dependsOn ?? []).length) continue;
      const dependency = await dependenciesSatisfied(task);
      if (!dependency.ok) {
        const nextState = dependency.blocked ? 'blocked' : (status.state === 'blocked' ? 'queued' : status.state);
        if (status.waitingReason !== dependency.reason || status.state !== nextState) {
          status.waitingReason = dependency.reason;
          status.state = nextState;
          status.blockedReason = dependency.blocked ? dependency.reason : undefined;
          await atomicJson(path.join(jobDir(root, id), 'status.json'), { ...status, blockedReason: status.blockedReason });
          await writeProgress(id, { id, state: nextState, phase: 'waiting-dependency', waitingFor: dependency.reason });
        }
        continue;
      }
      startJob(task, status, null);
    }
  }

  async function startInboxJobs() {
    for (const file of (await fs.readdir(path.join(root, 'inbox')).catch(() => [])).sort()) {
      if (active.size >= config.maxConcurrent) break;
      if (!file.endsWith('.json') || !validId(file.slice(0, -5))) continue;
      const input = path.join(root, 'inbox', file);
      if (!(await fs.lstat(input)).isFile()) continue;
      let task;
      try {
        const stat = await fs.stat(input); if (stat.size > 262144) throw new Error('Task exceeds 256 KiB');
        task = validateTask(JSON.parse(await fs.readFile(input, 'utf8')), config);
        if (file !== task.id + '.json') throw new Error('Task id must match filename');
        const cwdStat = await fs.stat(task.cwd); if (!cwdStat.isDirectory()) throw new Error('cwd must exist as directory');
      } catch (error) {
        await fs.rename(input, input + '.invalid'); ctx.logger.warn(`Rejected ${file}: ${String(error)}`); continue;
      }
      const dir = jobDir(root, task.id);
      try { await fs.mkdir(dir, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; await fs.rename(input, input + '.duplicate'); continue; }
      await fs.rename(input, path.join(dir, 'task.json'));

      const dependency = await dependenciesSatisfied(task);
      const status = {
        id: task.id, state: dependency.ok ? 'queued' : dependency.blocked ? 'blocked' : 'queued',
        attempt: 1, createdAt: nowIso(), startedAt: null, goal: task.goal,
        maxSteps: task.maxSteps, timeoutSeconds: task.timeoutSeconds,
        dependsOn: task.dependsOn ?? [], dependencyPolicy: task.dependencyPolicy ?? 'accepted',
        sessionId: null, steps: 0, review: { state: 'pending' },
        blockedReason: dependency.ok ? undefined : dependency.reason,
      };
      await atomicJson(path.join(dir, 'status.json'), status);
      await writeProgress(task.id, { id: task.id, state: status.state, step: 0, maxSteps: task.maxSteps, phase: dependency.ok ? 'starting' : 'waiting-dependency', waitingFor: dependency.reason ?? null });
      if (dependency.ok) startJob(task, status, null);
    }
  }

  async function dependenciesSatisfied(task) {
    for (const dep of task.dependsOn ?? []) {
      const status = await readJson(path.join(jobDir(root, dep), 'status.json'), null).catch(() => null);
      if (!status) return { ok: false, blocked: false, reason: `依赖 ${dep} 尚未创建` };
      if (!isTerminal(status.state)) return { ok: false, blocked: false, reason: `依赖 ${dep} 仍在 ${status.state}` };
      if (!REVIEWABLE_STATES.has(status.state)) return { ok: false, blocked: true, reason: `依赖 ${dep} 处于 ${status.state}` };
      if (task.dependencyPolicy === 'accepted' && status.review?.state !== 'accepted') {
        return { ok: false, blocked: false, reason: `依赖 ${dep} 等待 Codex 验收（review=${status.review?.state ?? 'pending'}）` };
      }
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- 任务句柄
  function startJob(task, status, signals) {
    const handle = createHandle(task, status, signals);
    active.set(task.id, handle);
    handles.set(task.id, handle);
    handle.promise = runJob(handle)
      .catch(error => ctx.logger.warn(`bridge task ${task.id}: ${String(error)}`))
      .finally(() => {
        active.delete(task.id);
        handles.delete(task.id);
        if (handle.sessionId) {
          sessionIndex.delete(handle.sessionId);
          activeSessions.delete(handle.sessionId);
        }
      });
    return handle;
  }

  async function writeProgress(id, patch) {
    if (!validId(id)) return;
    const file = path.join(jobDir(root, id), 'progress.json');
    const current = await readJson(file, {}).catch(() => ({}));
    await atomicJson(file, { ...current, ...patch, updatedAt: nowIso() }).catch(() => {});
  }

  function createHandle(task, status, signals) {
    const dir = jobDir(root, task.id);
    const handle = {
      job: { ...status },
      task,
      dir,
      attempt: signals ? (status.attempt ?? 1) + 1 : 1,
      signals,
      steps: 0,
      lastSeq: 0,
      lastText: '',
      lastTool: null,
      lastToolAt: null,
      lastActivityAt: Date.now(),
      reason: null,
      stopCause: null,
      steers: 0,
      journal: [],
      pendingCalls: new Map(),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
      wrapped: { steps: false, time: false },
      sessionId: status.sessionId ?? null,
      agent: undefined,
      admission: undefined,
      draining: null,
      pendingSteers: [],
      journalChain: Promise.resolve(),
    };
    handle.appendJournal = entries => {
      const list = Array.isArray(entries) ? entries : [entries];
      handle.journal.push(...list);
      const text = list.map(entry => JSON.stringify(entry)).join('\n');
      if (text) handle.journalChain = handle.journalChain.then(() => fs.appendFile(path.join(dir, 'journal.ndjson'), text + '\n', { mode: 0o600 })).catch(() => {});
    };
    handle.ingest = event => {
      if (!event || typeof event.seq !== 'number') return;
      if (event.seq < handle.lastSeq) return;
      handle.lastSeq = event.seq + 1;
      processEvent(handle, event);
    };
    handle.cancel = cause => {
      if (handle.stopCause) return;
      handle.stopCause = cause;
      handle.appendJournal({ t: nowIso(), k: 'budget', attempt: handle.attempt, kind: cause, note: 'stop requested' });
      handle.admission?.abort();
      handle.agent?.cancel?.({ kind: 'user' });
    };
    return handle;
  }

  function processEvent(handle, event) {
    const data = event.data ?? {};
    handle.lastActivityAt = Date.now();
    if (EVENT_LOG_TYPES.has(event.type)) {
      const line = JSON.stringify(event) + '\n';
      handle.journalChain = handle.journalChain.then(() => fs.appendFile(path.join(handle.dir, 'events.jsonl'), line, { mode: 0o600 })).catch(() => {});
    }
    if (event.type === 'step/start') {
      handle.steps++;
    } else if (event.type === 'tool/call') {
      handle.lastTool = data.name ?? null;
      handle.lastToolAt = Date.now();
      handle.pendingCalls.set(data.callId, { name: data.name, args: data.arguments, step: data.step ?? handle.steps });
    } else if (event.type === 'tool/result') {
      const meta = resultMeta(event);
      const callId = meta.callId ?? data.callId ?? data.message?.toolCallId ?? null;
      const call = handle.pendingCalls.get(callId) ?? { name: 'unknown', args: undefined, step: data.step ?? handle.steps };
      handle.pendingCalls.delete(callId);
      const command = commandOf(call.name, call.args);
      const entries = [{
        t: nowIso(), k: 'tool', attempt: handle.attempt, step: call.step, tool: call.name, callId,
        ok: !meta.isError, exitCode: meta.exitCode, chars: meta.chars,
      }];
      if (command) {
        entries.push({
          t: nowIso(), k: 'command', attempt: handle.attempt, step: call.step,
          command: truncate(command, 300), exitCode: meta.exitCode, ok: !meta.isError,
          sandbox: meta.sandbox, error: meta.errorMessage || null,
          output: truncate(meta.text.trim(), 400) || null,
        });
      }
      for (const file of touchedFiles(call.name, call.args)) {
        entries.push({ t: nowIso(), k: 'file', attempt: handle.attempt, step: call.step, path: path.isAbsolute(file.path) ? path.normalize(file.path) : path.resolve(handle.task.cwd, file.path), kind: file.kind, ok: !meta.isError });
      }
      if (meta.isError) {
        entries.push({ t: nowIso(), k: 'denial', attempt: handle.attempt, step: call.step, tool: call.name, reason: meta.errorMessage || truncate(meta.text, 300), code: meta.errorCode });
      }
      handle.appendJournal(entries);
    } else if (event.type === 'assistant/message') {
      const message = data.message ?? {};
      handle.lastText = (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
      const usage = data.usage ?? message.usage;
      if (usage) {
        // input/output 是每条消息的增量；total/cacheRead 在真机上是累计值，取最新。
        handle.usage.inputTokens += usage.inputTokens ?? 0;
        handle.usage.outputTokens += usage.outputTokens ?? 0;
        handle.usage.totalTokens = Math.max(handle.usage.totalTokens, usage.totalTokens ?? 0);
        handle.usage.cacheReadTokens = Math.max(handle.usage.cacheReadTokens, usage.cacheReadTokens ?? 0);
        handle.appendJournal({ t: nowIso(), k: 'usage', attempt: handle.attempt, ...usage });
      }
    } else if (event.type === 'approval/decided') {
      handle.appendJournal({ t: nowIso(), k: 'approval', attempt: handle.attempt, tool: data.toolName ?? null, outcome: data.outcome ?? null });
    } else if (event.type === 'turn/end') {
      handle.reason = data.reason ?? null;
    }
  }

  /** Pull events the live session appended (works with or without ctx.on). */
  function reconcile(handle) {
    const session = handle.agent?.session;
    if (!session) return;
    while (handle.lastSeq < session.seq) {
      const event = session.eventAt(handle.lastSeq);
      if (!event) break;
      handle.ingest(event);
    }
  }

  // ---------------------------------------------------------------- 执行
  async function runJob(handle) {
    await runAttempt(handle);
  }

  async function runAttempt(handle) {
    const { task, dir } = handle;
    const attempt = handle.attempt;
    const admission = new AbortController();
    handle.admission = admission;
    handle.steps = 0;
    handle.lastText = '';
    handle.reason = null;
    handle.stopCause = null;
    handle.wrapped = { steps: false, time: false };
    handle.pendingCalls.clear();

    if (attempt > 1) await archiveAttempt(handle, attempt - 1);
    await fs.mkdir(path.join(dir, 'attempts', String(attempt)), { recursive: true, mode: 0o700 });

    const startedAt = Date.now();
    const previousSteps = handle.job.steps ?? 0;
    const status = {
      ...handle.job, id: task.id, attempt, goal: task.goal, maxSteps: task.maxSteps, timeoutSeconds: task.timeoutSeconds,
      state: 'running', startedAt: nowIso(), steps: 0, review: { state: 'pending' },
    };
    if (handle.signals?.resume?.note) status.lastNote = handle.signals.resume.note;
    if (handle.signals?.answers?.length) status.lastAnswer = handle.signals.answers.map(a => a.text).join('\n');
    handle.job = status;
    await atomicJson(path.join(dir, 'status.json'), status);
    handle.appendJournal({ t: nowIso(), k: 'state', attempt, state: 'running', note: reviewNoteFor(handle, { peek: true }) ?? null });

    const monitor = setInterval(() => {
      try { monitorTick(handle, startedAt); } catch (error) { ctx.logger.warn(`bridge monitor ${task.id}: ${String(error)}`); handle.cancel('capture_error'); }
    }, Math.max(50, Math.min(pollMs, 1000)));

    try {
      const session = await resolveSession(handle);
      handle.sessionId = session.sessionId;
      handle.job.sessionId = session.sessionId;
      handle.job.sessionMode = session.mode;
      handle.job.lineage = session.lineage;
      sessionIndex.set(session.sessionId, task.id);
      activeSessions.set(session.sessionId, {
        jobId: task.id,
        cwd: canonicalPathSync(task.cwd),
        writeScope: task.writeScope?.length ? task.writeScope.map(canonicalPathSync) : null,
        startedAt: nowIso(),
      });
      await atomicJson(path.join(dir, 'status.json'), handle.job);

      const agent = await waitForAgent(ctx, session.sessionId);
      if (!agent) throw new Error(`Session controller produced no live agent for ${session.sessionId}`);
      handle.agent = agent;
      reconcile(handle);

      await ctx.sessionController.prompt({
        sessionId: session.sessionId,
        requestId: `bridge:${task.id}:${attempt}`,
        content: [{ type: 'text', text: promptFor(task, config, { attempt, stepsUsed: previousSteps, reviewNote: reviewNoteFor(handle), contextPack: session.contextPack }) }],
        mode: 'queue',
        clientTimeZone: config.clientTimeZone,
      }, admission.signal);

      for (;;) {
        await agent.whenIdle();
        reconcile(handle);
        const delivered = await drainSteers(handle, agent);
        if (!delivered) break;
        await sleep(200);
      }

      clearInterval(monitor);
      reconcile(handle);
      await handle.journalChain;
      try { await ctx.sessions.flush(agent.session); } catch (error) { ctx.logger.warn(`bridge flush ${task.id}: ${String(error)}`); }

      const state = handle.stopCause
        ?? (handle.reason?.kind === 'completed' ? 'completed'
          : handle.reason?.kind === 'blocked' ? 'blocked'
            : handle.reason?.kind === 'cancelled' ? 'cancelled' : 'failed');
      await finalize(handle, state, startedAt);
    } catch (error) {
      clearInterval(monitor);
      handle.agent?.cancel?.({ kind: 'user' });
      await handle.journalChain.catch(() => {});
      if (admission.signal.aborted && handle.stopCause) await finalize(handle, handle.stopCause, startedAt);
      else await finalize(handle, 'failed', startedAt, String(error));
    } finally {
      handle.admission = undefined;
      clearInterval(monitor);
    }
  }

  function reviewNoteFor(handle, { peek = false } = {}) {
    const parts = [];
    if (handle.signals?.answers?.length) parts.push(`【Codex 回答】\n${handle.signals.answers.map(a => a.text).join('\n')}`);
    if (handle.signals?.resume?.note) parts.push(`【Codex 返工要求】\n${handle.signals.resume.note}`);
    const note = parts.filter(Boolean).join('\n\n') || undefined;
    if (!peek) handle.signals = null;
    return note;
  }

  async function waitForAgent(ctx, sessionId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const agent = ctx.agents.get(sessionId);
      if (agent) return agent;
      if (Date.now() > deadline) return undefined;
      await sleep(50);
    }
  }

  /** 优先复用同一会话；其次 fork；最后冷启动并附带前序摘要。 */
  async function resolveSession(handle) {
    const { task } = handle;
    const previous = handle.job.sessionId ?? null;
    const fresh = handle.signals?.resume?.fresh === true || handle.job.forceFresh === true;
    if (handle.attempt > 1 && previous && !fresh) {
      if (ctx.agents.get(previous)) return { sessionId: previous, mode: 'same', lineage: [...(handle.job.lineage ?? []), previous] };
      if (typeof ctx.sessionController.fork === 'function') {
        const forked = await ctx.sessionController.fork({ sessionId: previous }).catch(error => {
          ctx.logger.warn(`bridge fork ${task.id}: ${String(error)}`);
          return null;
        });
        if (forked?.sessionId) return { sessionId: forked.sessionId, mode: 'fork', lineage: [...(handle.job.lineage ?? []), previous, forked.sessionId] };
      }
      const contextPack = await buildContextPack(handle, previous);
      const workspace = await ctx.workspaceRegistry.create(task.cwd, `Codex · ${path.basename(task.cwd)}`);
      const created = await ctx.sessionController.create({ workspaceId: workspace.id });
      await ctx.sessionController.rename({ sessionId: created.sessionId, title: `Codex · ${task.goal.slice(0, 50)}` }).catch(() => {});
      return { sessionId: created.sessionId, mode: 'context', contextPack, lineage: [...(handle.job.lineage ?? []), previous, created.sessionId] };
    }
    const workspace = await ctx.workspaceRegistry.create(task.cwd, `Codex · ${path.basename(task.cwd)}`);
    const created = await ctx.sessionController.create({ workspaceId: workspace.id });
    await ctx.sessionController.rename({ sessionId: created.sessionId, title: `Codex · ${task.goal.slice(0, 50)}` }).catch(() => {});
    return { sessionId: created.sessionId, mode: 'new', lineage: [...(handle.job.lineage ?? []), created.sessionId] };
  }

  async function buildContextPack(handle, previousSessionId) {
    const previousResult = await readJson(path.join(handle.dir, 'result.json'), null).catch(() => null);
    const previousEvidence = await readJson(path.join(handle.dir, 'evidence.json'), null).catch(() => null);
    const parts = [`上一轮会话：${previousSessionId}（不可复用，以下是工作摘要）`];
    if (previousResult) {
      parts.push(`上一轮结论（${previousResult.outcome}）：${truncate(previousResult.summary ?? '', 1500)}`);
      if (previousResult.changes?.length) parts.push(`上一轮声称改动：\n${previousResult.changes.slice(0, 30).map(c => `- [${c.kind}] ${c.path}`).join('\n')}`);
      if (previousResult.blockers?.length) parts.push(`上一轮阻碍：\n${previousResult.blockers.slice(0, 10).map(b => `- ${b}`).join('\n')}`);
    }
    if (previousEvidence?.files?.length) {
      parts.push(`上一轮实际触碰的文件（worker 采集，含哈希）：\n${previousEvidence.files.slice(0, 40).map(f => `- ${f.path} sha256:${(f.sha256 ?? 'n/a').slice(0, 12)}`).join('\n')}`);
    }
    parts.push('请先用最小步骤核对上述文件的实际状态，再继续未完成部分，不要重做已完成且已验证的工作。');
    return parts.join('\n');
  }

  async function archiveAttempt(handle, previousAttempt) {
    const target = path.join(handle.dir, 'attempts', String(previousAttempt));
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of ['result.md', 'result.json', 'evidence.json']) {
      await fs.rename(path.join(handle.dir, name), path.join(target, name)).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 监控
  function monitorTick(handle, startedAt) {
    if (stopped) return handle.cancel('plugin_unloaded');
    reconcile(handle);
    const elapsed = Date.now() - startedAt;
    const stepsLeft = handle.task.maxSteps - handle.steps;
    const secondsLeft = handle.task.timeoutSeconds - Math.floor(elapsed / 1000);

    if (!handle.wrapped.steps && handle.task.wrapUpSteps > 0 && stepsLeft <= handle.task.wrapUpSteps) {
      handle.wrapped.steps = true;
      handle.appendJournal({ t: nowIso(), k: 'budget', attempt: handle.attempt, kind: 'wrapup', note: `剩余 ${stepsLeft} 步` });
      requestSteer(handle, `【预算提醒】步数预算即将用尽（剩余 ${stepsLeft} 步）。最多再执行 3 步，然后立即输出最终交付（含 bridge-result 块）；未完成项写进 blockers/next，不要开始新的调查。`);
    }
    if (!handle.wrapped.time && handle.task.wrapUpSeconds > 0 && secondsLeft <= handle.task.wrapUpSeconds) {
      handle.wrapped.time = true;
      handle.appendJournal({ t: nowIso(), k: 'budget', attempt: handle.attempt, kind: 'wrapup', note: `剩余 ${secondsLeft} 秒` });
      requestSteer(handle, `【预算提醒】时间预算即将用尽（剩余 ${secondsLeft} 秒）。立即停止新调查，把当前进展与验证结果写成最终交付（含 bridge-result 块）。`);
    }
    drainSteers(handle, handle.agent).catch(error => ctx.logger.warn(`bridge steer ${handle.job.id}: ${String(error)}`));
    if (stepsLeft <= 0) handle.cancel('step_limit');
    if (elapsed > handle.task.timeoutSeconds * 1000) handle.cancel('timeout');
    fs.access(path.join(handle.dir, 'cancel')).then(() => handle.cancel('cancelled'), () => {});
    if (Date.now() - (handle.lastProgressAt ?? 0) < 1000) return;
    handle.lastProgressAt = Date.now();
    writeProgress(handle.job.id, {
      id: handle.job.id, state: 'running', attempt: handle.attempt, step: handle.steps, maxSteps: handle.task.maxSteps,
      stepsLeft: Math.max(0, stepsLeft), secondsLeft: Math.max(0, secondsLeft),
      phase: handle.wrapped.steps || handle.wrapped.time ? 'wrapping' : 'running',
      lastTool: handle.lastTool, lastToolAt: handle.lastToolAt ? new Date(handle.lastToolAt).toISOString() : null,
      sessionId: handle.sessionId, sessionMode: handle.job.sessionMode ?? null, steers: handle.steers,
      startedAt: new Date(startedAt).toISOString(), elapsedMs: elapsed,
    }).catch(() => {});
  }

  async function drainSteers(handle, agent) {
    if (handle.draining) return handle.draining;
    handle.draining = (async () => {
      const dir = path.join(handle.dir, 'steer');
      const names = (await fs.readdir(dir).catch(() => [])).filter(v => v.endsWith('.json')).sort();
      const pending = [];
      for (const name of names) {
        const file = path.join(dir, name);
        const payload = await readJson(file, null).catch(() => null);
        await fs.unlink(file).catch(() => {});
        if (payload?.text) pending.push(payload);
      }
      pending.push(...handle.pendingSteers.splice(0));
      let delivered = false;
      for (const payload of pending) {
        const running = agent?.status === 'running';
        try {
          await ctx.sessionController.prompt({
            sessionId: handle.sessionId,
            requestId: `bridge:${handle.job.id}:${handle.attempt}:steer:${payload.seq ?? 'x'}`,
            content: [{ type: 'text', text: `【Codex 中途指令】${payload.text}` }],
            mode: running ? 'steer' : 'queue',
            clientTimeZone: config.clientTimeZone,
          }, handle.admission?.signal ?? new AbortController().signal);
          delivered = true;
          handle.steers++;
          handle.appendJournal({ t: nowIso(), k: 'steer', attempt: handle.attempt, text: truncate(payload.text, 2000), mode: running ? 'steer' : 'queue' });
        } catch (error) {
          handle.appendJournal({ t: nowIso(), k: 'steer', attempt: handle.attempt, text: truncate(payload.text, 2000), error: String(error) });
        }
      }
      return delivered;
    })().finally(() => { handle.draining = null; });
    return handle.draining;
  }

  function requestSteer(handle, text) {
    if (!handle.sessionId) return;
    handle.pendingSteers.push({ seq: `budget-${randomUUID()}`, text, budget: true });
  }

  // ---------------------------------------------------------------- 收尾
  async function finalize(handle, state, startedAt, error) {
    const { task, dir } = handle;
    const durationMs = Date.now() - startedAt;
    const result = parseBridgeResult(handle.lastText, { state, task });
    if (!handle.stopCause && result.outcome === 'needs_input' && result.questions.length) state = 'needs_input';
    const evidence = await collectEvidence({
      task, journal: handle.journal, durationMs, sessionId: handle.sessionId,
      status: { id: task.id, attempt: handle.attempt, state, steps: handle.steps, startedAt: new Date(startedAt).toISOString(), finishedAt: nowIso() },
    });
    const resultText = handle.lastText.trim()
      ? handle.lastText
      : '（执行未产出最终答复；请查看 result.json / evidence.json / journal.ndjson，必要时用 repair 续跑。）';
    await fs.writeFile(path.join(dir, 'result.md'), resultText + '\n', { mode: 0o600 });
    await atomicJson(path.join(dir, 'result.json'), result);
    await atomicJson(path.join(dir, 'evidence.json'), evidence);

    const status = {
      ...handle.job,
      id: task.id,
      state,
      attempt: handle.attempt,
      steps: handle.steps,
      maxSteps: task.maxSteps,
      reason: handle.reason ?? null,
      stoppedBy: handle.stopCause ?? null,
      sessionId: handle.sessionId ?? null,
      outcome: result.outcome,
      structured: result.structured === true,
      summary: truncate(result.summary ?? '', 1200),
      blockers: result.blockers ?? [],
      questions: result.questions ?? [],
      usage: handle.usage,
      steers: handle.steers,
      durationMs,
      finishedAt: nowIso(),
      review: { state: 'pending' },
      artifacts: {
        result: 'result.json', resultText: 'result.md', evidence: 'evidence.json',
        journal: 'journal.ndjson', events: 'events.jsonl', attemptDir: `attempts/${handle.attempt}`,
      },
    };
    if (state === 'needs_input') status.pendingQuestion = { seq: handle.attempt, questions: result.questions, askedAt: nowIso() };
    if (error) status.error = error;
    handle.job = status;
    await atomicJson(path.join(dir, 'status.json'), status);
    await writeProgress(task.id, {
      id: task.id, state, attempt: handle.attempt, step: handle.steps, maxSteps: task.maxSteps,
      phase: 'finished', lastTool: handle.lastTool, elapsedMs: durationMs, sessionId: handle.sessionId,
      waitingFor: state === 'needs_input' ? 'Codex 回答（answer 命令）' : null,
    });
    handle.appendJournal({ t: nowIso(), k: 'state', attempt: handle.attempt, state, durationMs, outcome: result.outcome, steps: handle.steps });
    await handle.journalChain;
  }

  // ---------------------------------------------------------------- 清理
  timer = setInterval(() => tick().catch(error => ctx.logger.warn(`bridge tick: ${String(error)}`)), pollMs);
  await tick();

  return async () => {
    stopped = true;
    clearInterval(timer);
    for (const handle of active.values()) handle.cancel('plugin_unloaded');
    offSessionEvent?.();
    await atomicJson(path.join(root, 'health.json'), { version: BRIDGE_VERSION, stopped: true, updatedAt: nowIso() }).catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  };
}

async function ensureToken(root) {
  const file = path.join(root, 'token');
  try {
    await fs.readFile(file, 'utf8');
  } catch {
    await fs.writeFile(file, randomUUID().replaceAll('-', ''), { mode: 0o600 });
  }
}
