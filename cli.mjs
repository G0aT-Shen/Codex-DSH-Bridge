// Codex 派工桥 v2 —— 命令行接口（也是 MCP 服务器与 HTTP API 的共同实现）
//
// 用法：
//   bridge.mjs health [--json]
//   bridge.mjs submit TASK.json [--batch] [--json]
//   bridge.mjs list [--json]
//   bridge.mjs status ID [--json]
//   bridge.mjs progress ID [--json]
//   bridge.mjs watch ID [--timeout 120] [--json]      # 长轮询，状态变化或终态才返回
//   bridge.mjs tail ID [-n 20] [--json]
//   bridge.mjs digest ID [--json]                     # 审查包：结果+证据+摘要，替代读 events.jsonl
//   bridge.mjs result ID [--json]
//   bridge.mjs steer ID "TEXT"                        # 运行中会话的中途指令
//   bridge.mjs repair ID "NOTE" [--fresh]             # 同一会话续跑；--fresh 强制新会话
//   bridge.mjs resume ID ["NOTE"]                     # interrupted 任务恢复
//   bridge.mjs cancel ID
//   bridge.mjs review ID accepted|changes_requested "NOTE"
//   bridge.mjs questions [--json]                     # 等待 Codex 回答的任务
//   bridge.mjs answer ID "TEXT" [--seq N]
//   bridge.mjs config [--set k=v ...] [--json]
//   bridge.mjs mcp                                    # 启动 stdio MCP 服务器
//
// 全局选项：--root DIR

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJobEvents, listCodexRequests, respondCodexRequest, readSharedMemory, putSharedMemory, callSharedHost } from './shared.mjs';
import {
  DEFAULT_ROOT, atomicJson, healthIsAlive, isTerminal, jobDir, listJobs, listPendingQuestions,
  loadConfig, readEvidence, readJournal, readProgress, readResult, readStatus, readTask,
  readArtifact, renderDigest, repairJob, answerQuestion, cancelJob, reviewJob, steerJob, submitTask,
  updateConfig, validId, waitForJob, readJson, queueDir as defaultQueueDir,
} from './protocol.js';

export const HUMAN_HELP = [
  'Commands: health | submit FILE [--batch] | list | status ID | progress ID | watch ID [--timeout S]',
  '          tail ID [-n N] | digest ID | result ID | steer ID TEXT | repair ID NOTE [--fresh]',
  '          resume ID [NOTE] | cancel ID | review ID accepted|changes_requested NOTE',
  '          questions | answer ID TEXT [--seq N] | config [--set k=v] | mcp',
  '          events ID [--cursor BYTES] [-n N] | requests [JOB_ID] | respond REQUEST_ID (--inline JSON | --file FILE)',
  '          memory [KEY] | memory-put (--inline JSON | --file FILE) | sessions | session-events SESSION_ID [--cursor SEQ]',
  '          shared-status | shared-skills | shared-skill NAME',
].join('\n');

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--json') flags.json = true;
    else if (token === '--batch') flags.batch = true;
    else if (token === '--fresh') flags.fresh = true;
    else if (token === '--timeout') flags.timeout = Number(argv[++i]);
    else if (token === '--seq') flags.seq = Number(argv[++i]);
    else if (token === '--cursor') flags.cursor = Number(argv[++i]);
    else if (token === '-n' || token === '--lines') flags.lines = Number(argv[++i]);
    else if (token === '--root') flags.root = argv[++i];
    else if (token === '--set') (flags.set ??= []).push(argv[++i]);
    else if (token === '--inline') flags.inline = argv[++i];
    else if (token === '--file') {
      flags.file = argv[++i];
      if (!flags.file || flags.file.startsWith('--')) throw new Error('--file requires a JSON file path');
    }
    else if (token === '--all') flags.all = true;
    else positional.push(token);
  }
  return { positional, flags };
}

const print = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const asJson = (flags, data, text) => (flags.json ? JSON.stringify(data, null, 2) : (text ?? print(data)));
async function jsonPayload(flags, file) {
  if (flags.inline !== undefined && flags.file !== undefined) throw new Error('Use either --inline or --file, not both');
  if (flags.inline !== undefined) return JSON.parse(flags.inline.replace(/^\uFEFF/, ''));
  if (flags.file ?? file) return readJson(flags.file ?? file);
  throw new Error('Provide --inline JSON or --file FILE');
}

/** Execute one command. Returns {exitCode, stdout}. Used by the CLI, MCP server and HTTP API. */
export async function execute(argv, { root = DEFAULT_ROOT } = {}) {
  const { positional, flags } = parseArgs(argv);
  const [command, arg, ...rest] = positional;
  root = flags.root ?? root;
  if (!command) return { exitCode: 1, stdout: HUMAN_HELP };
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const config = await loadConfig(root);

  switch (command) {
    case 'health': {
      const health = await readJsonOrNull(path.join(root, 'health.json'));
      const alive = healthIsAlive(health, config.healthWindowMs);
      const data = { alive, version: health?.version ?? null, pid: health?.pid ?? null, updatedAt: health?.updatedAt ?? null,
        maxConcurrent: health?.maxConcurrent ?? config.maxConcurrent, activeCount: health?.activeCount ?? 0,
        activeTasks: health?.activeTasks ?? [], queued: health?.queued ?? 0, blocked: health?.blocked ?? 0,
        waitingInput: health?.waitingInput ?? [], queueDir: root, hasToken: Boolean(await readToken(root)) };
      if (!alive) data.hint = '桌面 DSH 未运行或未加载 Codex 派工桥插件；此时 submit 会被拒绝。';
      return { exitCode: alive ? 0 : 2, stdout: asJson(flags, data, alive
        ? `bridge alive (pid ${data.pid})；并发 ${data.activeCount}/${data.maxConcurrent}，排队 ${data.queued}，待回答 ${data.waitingInput.length}`
        : 'bridge 未运行：请打开桌面 DSH 并确认插件已启用。') };
    }
    case 'submit': {
      if (!arg && flags.inline === undefined && !flags.file) return { exitCode: 1, stdout: '用法：submit TASK.json [--batch] 或 submit --inline JSON / --file FILE' };
      const payload = await jsonPayload(flags, arg);
      const tasks = flags.batch || Array.isArray(payload) || Array.isArray(payload?.tasks)
        ? (Array.isArray(payload) ? payload : payload.tasks)
        : [payload];
      if (!Array.isArray(tasks) || !tasks.length) return { exitCode: 1, stdout: '批量文件需要 tasks 数组' };
      const health = await readJsonOrNull(path.join(root, 'health.json'));
      if (!healthIsAlive(health, config.healthWindowMs)) {
        return { exitCode: 2, stdout: 'DSH bridge offline. Open the desktop Harness and enable the Codex bridge plugin.' };
      }
      const accepted = [];
      for (const task of tasks) accepted.push(await submitTask(root, task, config));
      return { exitCode: 0, stdout: asJson(flags, { accepted }, `已入队：${accepted.map(a => a.id).join(', ')}`) };
    }
    case 'list': {
      const jobs = await listJobs(root);
      const rows = jobs
        .filter(job => flags.all || !isTerminal(job.state) || ['completed', 'needs_input', 'step_limit'].includes(job.state))
        .map(job => ({ id: job.id, state: job.state, attempt: job.attempt ?? 1, steps: job.steps ?? 0, outcome: job.outcome ?? null, review: job.review?.state ?? 'pending', goal: String(job.goal ?? '').slice(0, 60) }));
      const table = rows.map(row => `${row.id}\t${row.state}\t${row.steps}步\t${row.outcome ?? '-'}\t${row.review}\t${row.goal}`).join('\n') || '(无任务)';
      return { exitCode: 0, stdout: asJson(flags, rows, table) };
    }
    case 'status': {
      requireId(arg);
      const status = await readStatus(root, arg);
      const progress = await readProgress(root, arg);
      return { exitCode: 0, stdout: asJson(flags, { ...status, progress }, progress
        ? `${status.id}: ${status.state}（第${status.attempt ?? 1}次，${progress.step ?? status.steps ?? 0}/${status.maxSteps ?? '?'}步，${progress.lastTool ?? '-'}）`
        : print(status)) };
    }
    case 'progress': {
      requireId(arg);
      const progress = await readProgress(root, arg) ?? await readStatus(root, arg);
      return { exitCode: 0, stdout: print(progress) };
    }
    case 'watch': {
      requireId(arg);
      const timeoutMs = Number.isFinite(flags.timeout) ? Math.max(1, flags.timeout) * 1000 : 120000;
      const deadline = Date.now() + timeoutMs;
      const lines = [];
      let last = null;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const result = await waitForJob(root, arg, { timeoutMs: remaining, intervalMs: 500, interrupt: () => listCodexRequests(root, { jobId: arg }) });
        last = result;
        if (result.requests?.length) break;
        if (result.changed) {
          const snapshot = { at: new Date().toISOString(), state: result.status?.state ?? 'missing', step: result.progress?.step ?? null, lastTool: result.progress?.lastTool ?? null, waitingFor: result.progress?.waitingFor ?? null };
          lines.push(snapshot);
        }
        if (result.status && isTerminal(result.status.state)) break;
        if (result.timedOut) break;
      }
      const status = last?.status ?? await readStatus(root, arg).catch(() => null);
      const terminal = status ? isTerminal(status.state) : false;
      const data = { id: arg, state: status?.state ?? 'unknown', terminal, review: status?.review?.state ?? 'pending', outcome: status?.outcome ?? null,
        steps: status?.steps ?? null, maxSteps: status?.maxSteps ?? null, changes: lines,
        progress: await readProgress(root, arg), requests: last?.requests ?? [] };
      return { exitCode: terminal || data.requests.length ? 0 : 2, stdout: flags.json ? JSON.stringify(data) : (data.requests.length
        ? `${arg} 请求 Codex 能力：${data.requests.map(r => r.id).join(', ')}；用 requests / respond 处理后继续 watch。` : terminal
        ? `${arg} → ${data.state}（review=${data.review}）；用 digest 获取审查包。`
        : `${arg} 仍在 ${data.state}（第 ${data.steps ?? '?'} 步）；继续 watch 或先看 progress。`) };
    }
    case 'read': {
      requireId(arg);
      const requested = rest.join(' ').trim() || undefined;
      const result = await readArtifact(root, arg, requested);
      return { exitCode: 0, stdout: asJson(flags, result, result.content ?? result.files.join('\n')) };
    }
    case 'events': {
      requireId(arg);
      return { exitCode: 0, stdout: print(await readJobEvents(root, arg, { cursor: flags.cursor ?? 0, limit: flags.lines ?? 40 })) };
    }
    case 'requests':
      return { exitCode: 0, stdout: print(await listCodexRequests(root, { jobId: arg })) };
    case 'respond': {
      requireId(arg);
      return { exitCode: 0, stdout: print(await respondCodexRequest(root, { ...await jsonPayload(flags), id: arg })) };
    }
    case 'memory':
      return { exitCode: 0, stdout: print(await readSharedMemory(root, arg)) };
    case 'memory-put': {
      return { exitCode: 0, stdout: print(await putSharedMemory(root, await jsonPayload(flags))) };
    }
    case 'shared-status':
    case 'shared-skills':
    case 'shared-skill':
    case 'sessions':
    case 'session-events': {
      const names = { 'shared-status': 'status', 'shared-skills': 'skills', 'shared-skill': 'skill', sessions: 'sessions', 'session-events': 'events' };
      const args = flags.inline !== undefined || flags.file ? await jsonPayload(flags) : { name: arg, sessionId: arg, cursor: flags.cursor ?? 0, limit: flags.lines ?? 40 };
      return { exitCode: 0, stdout: print(await callSharedHost(root, names[command], args)) };
    }
    case 'tail': {
      requireId(arg);
      const lines = await readJournal(root, arg, Number.isFinite(flags.lines) ? flags.lines : 20);
      return { exitCode: 0, stdout: asJson(flags, lines, lines.map(entry => JSON.stringify(entry)).join('\n')) };
    }
    case 'digest':
    case 'result': {
      requireId(arg);
      const [status, progress, result, evidence, journal] = await Promise.all([
        readStatus(root, arg), readProgress(root, arg), readResult(root, arg), readEvidence(root, arg), readJournal(root, arg, 20),
      ]);
      if (flags.json || command === 'result') {
        const paths = artifactPaths(root, arg);
        const payload = { status, progress, result, evidence, journal, paths };
        // digest --json 同时给出结构化字段与可直接阅读的 markdown 审查包（MCP 工具用这条路径）
        if (command === 'digest') payload.digest = renderDigest({ status, progress, result, evidence, journalTail: journal, paths });
        return { exitCode: 0, stdout: JSON.stringify(payload, null, 2) };
      }
      const digest = renderDigest({ status, progress, result, evidence, journalTail: journal, paths: artifactPaths(root, arg) });
      return { exitCode: 0, stdout: digest };
    }
    case 'steer': {
      requireId(arg);
      const text = rest.join(' ').trim();
      const result = await steerJob(root, arg, text);
      return { exitCode: 0, stdout: `已投递 steer #${result.seq}（任务 ${result.state}）` };
    }
    case 'repair':
    case 'resume': {
      requireId(arg);
      const note = rest.join(' ').trim() || (command === 'resume'
        ? '恢复被中断的工作：先核对实际文件状态，避免重复副作用，然后完成剩余部分并给出最终交付。'
        : '');
      const result = await repairJob(root, arg, note, { fresh: flags.fresh === true });
      return { exitCode: 0, stdout: `已请求${command === 'resume' ? '恢复' : '返工'}：${result.id}（原状态 ${result.previousState}）；worker 会在同一会话续跑。` };
    }
    case 'cancel': {
      requireId(arg);
      const result = await cancelJob(root, arg);
      return { exitCode: 0, stdout: JSON.stringify(result) };
    }
    case 'review': {
      requireId(arg);
      const [verdict, ...noteParts] = rest;
      const status = await reviewJob(root, arg, verdict, noteParts.join(' '));
      return { exitCode: 0, stdout: JSON.stringify(status, null, 2) };
    }
    case 'questions': {
      const pending = await listPendingQuestions(root);
      const rows = pending.map(job => ({ id: job.id, attempt: job.attempt ?? 1, questions: job.questions ?? job.pendingQuestion?.questions ?? [], askedAt: job.pendingQuestion?.askedAt ?? job.finishedAt ?? null }));
      return { exitCode: 0, stdout: asJson(flags, rows, rows.length ? rows.map(row => `${row.id}: ${row.questions.join(' | ')}`).join('\n') : '(没有等待回答的任务)') };
    }
    case 'answer': {
      requireId(arg);
      const text = rest.join(' ').trim();
      const result = await answerQuestion(root, arg, text, { seq: Number.isFinite(flags.seq) ? flags.seq : null });
      return { exitCode: 0, stdout: `已回答 ${result.id} #${result.seq}；worker 将在同一会话续跑。` };
    }
    case 'config': {
      if (flags.set?.length) {
        const patch = {};
        for (const item of flags.set) {
          const [key, raw] = String(item).split('=');
          if (!key) continue;
          patch[key] = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
        }
        const next = await updateConfig(root, patch);
        return { exitCode: 0, stdout: JSON.stringify(next, null, 2) };
      }
      return { exitCode: 0, stdout: JSON.stringify(config, null, 2) };
    }
    case 'mcp': {
      const { startMcpServer } = await import('./mcp.mjs');
      await startMcpServer({ root });
      return { exitCode: 0, stdout: '' };
    }
    default:
      return { exitCode: 1, stdout: HUMAN_HELP };
  }
}

export async function main(args = process.argv.slice(2)) {
  const { exitCode, stdout } = await execute(args);
  if (stdout) console.log(stdout);
  process.exitCode = exitCode;
}

function requireId(id) {
  if (!validId(id)) throw new Error('Provide a valid task id');
}

function artifactPaths(root, id) {
  const dir = jobDir(root, id);
  return {
    dir, task: path.join(dir, 'task.json'), result: path.join(dir, 'result.json'),
    evidence: path.join(dir, 'evidence.json'), journal: path.join(dir, 'journal.ndjson'),
    events: path.join(dir, 'events.jsonl'), status: path.join(dir, 'status.json'),
    progress: path.join(dir, 'progress.json'), resultText: path.join(dir, 'result.md'),
  };
}

async function readJsonOrNull(file) {
  try { return await readJson(file); } catch { return null; }
}

async function readToken(root) {
  try { return (await fs.readFile(path.join(root, 'token'), 'utf8')).trim(); } catch { return null; }
}

export { defaultQueueDir };

// 作为可执行入口：node cli.mjs health | submit ... | mcp
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
}
