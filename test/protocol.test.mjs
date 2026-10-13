import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  atomicJson, collectEvidence, commandOf, parseBridgeResult, renderDigest, resultMeta, reviewJob,
  submitTask, touchedFiles, validateTask, waitForJob, answerQuestion, repairJob, steerJob,
} from '../protocol.js';
import {makeFake, startFixture, tempRoot, until, pause} from './helpers.mjs';
import {activeSessions, canonicalPathSync, writeScopeAllows, validId} from '../protocol.js';
import {writeScopeGuard} from '../boot.js';

const task = (root, overrides = {}) => ({
  id: 'job-one', cwd: root, goal: 'g', plan: ['p'], acceptance: ['a'], ...overrides,
});

test('job IDs exclude Windows device names on every platform', () => {
  for (const id of ['CON', 'nul', 'AUX', 'PRN', 'COM1', 'lpt9']) assert.equal(validId(id), false, id);
  for (const id of ['console', 'com10', 'job-CON', 'job-one']) assert.equal(validId(id), true, id);
});

test('task validation applies v2 defaults and rejects bad input', () => {
  const normalized = validateTask({id: 'x', cwd: '/tmp', goal: 'g', plan: ['p'], acceptance: ['a']});
  assert.equal(normalized.timeoutSeconds, 1800);
  assert.equal(normalized.maxSteps, 40);
  assert.equal(normalized.wrapUpSteps, 8);
  assert.equal(normalized.dependencyPolicy, 'accepted');
  assert.throws(() => validateTask({id: 'x', cwd: 'rel', goal: 'g', plan: ['p'], acceptance: ['a']}), /cwd must be absolute/);
  assert.throws(() => validateTask({id: 'x', cwd: '/tmp', goal: 'g', plan: [], acceptance: ['a']}), /Non-empty plan/);
  assert.throws(() => validateTask({id: 'x', cwd: '/tmp', goal: 'g', plan: ['p'], acceptance: ['a'], dependsOn: ['x']}), /cannot depend on itself/);
  assert.throws(() => validateTask({id: 'x', cwd: '/tmp', goal: 'g', plan: ['p'], acceptance: ['a'], dependsOn: ['a b']}), /Invalid dependsOn/);
  assert.throws(() => validateTask({id: 'x', cwd: '/tmp', goal: 'g', plan: ['p'], acceptance: ['a'], authorization: {sudo: true}}), /Invalid authorization key/);
  assert.throws(() => validateTask({id: 'x', cwd: '/tmp', goal: 'g', plan: ['p'], acceptance: ['a'], maxSteps: 5, wrapUpSteps: 5}), /Invalid wrapUpSteps/);
  const scoped = validateTask({id: 'x', cwd: '/tmp/work', goal: 'g', plan: ['p'], acceptance: ['a'], writeScope: ['src']});
  assert.deepEqual(scoped.writeScope, [canonicalPathSync('/tmp/work/src')], 'writeScope 会被规范化（/tmp → /private/tmp）');
});

test('bridge-result contract parsing tolerates missing and malformed blocks', () => {
  const good = parseBridgeResult([
    '做完了',
    '```bridge-result',
    JSON.stringify({outcome: 'completed', summary: 'ok', changes: [{path: '/a', kind: 'create'}], verification: [{command: 'pytest', exitCode: 0, result: '3 passed'}], blockers: [], next: ['nothing']}),
    '```',
  ].join('\n'), {state: 'completed'});
  assert.equal(good.structured, true);
  assert.equal(good.outcome, 'completed');
  assert.equal(good.changes[0].path, '/a');
  assert.equal(good.verification[0].exitCode, 0);

  const malformed = parseBridgeResult('```bridge-result\n{not json}\n```', {state: 'completed'});
  assert.equal(malformed.structured, false);
  assert.match(malformed.note, /not valid JSON/);

  const missing = parseBridgeResult('只有散文', {state: 'step_limit'});
  assert.equal(missing.structured, false);
  assert.equal(missing.outcome, 'partial');
  assert.match(missing.note, /missing bridge-result/);

  const needsInput = parseBridgeResult('```bridge-result\n{"outcome":"needs_input","questions":["选 A 还是 B？"]}\n```', {state: 'completed'});
  assert.equal(needsInput.outcome, 'needs_input');
  assert.deepEqual(needsInput.questions, ['选 A 还是 B？']);
});

test('tool arguments yield touched files, commands and result metadata', () => {
  assert.deepEqual(touchedFiles('write', {file_path: '/tmp/a.txt'}), [{path: '/tmp/a.txt', kind: 'create'}]);
  assert.deepEqual(touchedFiles('edit', JSON.stringify({path: 'src/b.js'})), [{path: 'src/b.js', kind: 'edit'}]);
  assert.deepEqual(touchedFiles('read', {path: '/tmp/a'}), []);
  assert.equal(commandOf('bash', {command: 'ls -la'}), 'ls -la');
  assert.equal(commandOf('read', {path: '/tmp/a'}), null);

  const meta = resultMeta({data: {callId: 'c1', message: {content: [{type: 'text', text: 'boom\n[exit code: 2]'}], isError: true, error: {message: 'the user rejected tool "bash"'}}}});
  assert.equal(meta.isError, true);
  assert.equal(meta.exitCode, 2);
  assert.match(meta.errorMessage, /rejected/);
});

test('evidence hashes real files, flags out-of-scope writes and counts usage', async t => {
  const root = await tempRoot(t);
  const inside = path.join(root, 'inside.txt');
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(inside, 'hello');
  await fs.writeFile(outside, 'nope');
  const evidence = await collectEvidence({
    task: {writeScope: [path.join(root, 'sub')]},
    journal: [
      {k: 'file', step: 1, path: inside, kind: 'create', ok: true},
      {k: 'file', step: 2, path: outside, kind: 'edit', ok: true},
      {k: 'command', step: 3, command: 'pytest', exitCode: 1, ok: false},
      {k: 'denial', step: 4, tool: 'bash', reason: 'the user rejected tool "bash"'},
      {k: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0},
      {k: 'steer', text: '收敛范围'},
      {k: 'budget', kind: 'wrapup', note: '剩余 2 步'},
    ],
    status: {id: 'job-one', attempt: 1, state: 'completed', steps: 4},
  });
  const byPath = Object.fromEntries(evidence.files.map(file => [file.path, file]));
  assert.equal(byPath[inside].inWriteScope, false);
  assert.equal(byPath[inside].sha256.length, 64);
  assert.equal(byPath[outside].inWriteScope, false);
  assert.equal(evidence.commands.length, 1);
  assert.equal(evidence.commands[0].exitCode, 1);
  assert.equal(evidence.denials.length, 1);
  assert.equal(evidence.usage.totalTokens, 15);
  assert.equal(evidence.steers[0].text, '收敛范围');
  assert.equal(evidence.wrapUps, 1);
});

test('submitTask dedupes ids and waitForJob returns on change', async t => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'jobs', 'job-one'), {recursive: true});
  const config = {defaultTimeoutSeconds: 1800, defaultMaxSteps: 40, wrapUpSteps: 8, wrapUpSeconds: 120};
  await assert.rejects(submitTask(root, task(root), config), /already used/);
  await submitTask(root, task(root, {id: 'job-two'}), config);
  assert.deepEqual(await fs.readdir(path.join(root, 'inbox')), ['job-two.json']);
  await fs.mkdir(path.join(root, 'jobs', 'job-two'), {recursive: true});

  await atomicJson(path.join(root, 'jobs', 'job-two', 'status.json'), {id: 'job-two', state: 'running', attempt: 1});
  const pending = waitForJob(root, 'job-two', {timeoutMs: 500, intervalMs: 20});
  await pause(80);
  await atomicJson(path.join(root, 'jobs', 'job-two', 'status.json'), {id: 'job-two', state: 'completed', attempt: 1, steps: 3});
  const result = await pending;
  assert.equal(result.changed, true);
  assert.equal(result.status.state, 'completed');

  const terminal = await waitForJob(root, 'job-two', {timeoutMs: 80, intervalMs: 20});
  assert.equal(terminal.status.state, 'completed');
  assert.equal(terminal.changed, false);
});

test('completed job produces structured artifacts, evidence and journal', async t => {
  const finalText = '交付完成\n```bridge-result\n{"outcome":"completed","summary":"done","changes":[{"path":"/tmp/x","kind":"create"}],"verification":[{"command":"echo hi","exitCode":0,"result":"hi"}],"blockers":[],"next":[]}\n```';
  let artifactPath;
  const fixture = await startFixture(t, {
    script: async ({push}) => {
      push('step/start', {turn: 1, step: 1});
      push('tool/call', {turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({file_path: artifactPath})});
      await fs.writeFile(artifactPath, 'artifact');
      push('tool/result', {turn: 1, step: 1, callId: 'c1', message: {content: [{type: 'text', text: 'written'}], isError: false}});
      push('assistant/message', {turn: 1, step: 1, message: {content: [{type: 'text', text: finalText}]}, usage: {inputTokens: 7, outputTokens: 3, totalTokens: 10}});
      push('step/end', {turn: 1, step: 1});
    },
  });
  artifactPath = path.join(fixture.root, 'artifact.txt');
  await submitTask(fixture.root, task(fixture.root), fixture.config);
  const status = await until(() => fixture.readStatus('job-one'), s => s.state === 'completed');
  assert.equal(status.outcome, 'completed');
  assert.equal(status.structured, true);
  assert.equal(status.review.state, 'pending');

  const result = JSON.parse(await fixture.readArtifact('job-one', 'result.json'));
  assert.equal(result.summary, 'done');
  const evidence = JSON.parse(await fixture.readArtifact('job-one', 'evidence.json'));
  assert.equal(evidence.files.length, 1);
  assert.equal(evidence.files[0].sha256.length, 64);
  assert.equal(evidence.usage.totalTokens, 10);
  const journal = await fixture.readArtifact('job-one', 'journal.ndjson');
  assert.match(journal, /"k":"file"/);
  assert.match(journal, /"k":"state"/);
  const progress = JSON.parse(await fixture.readArtifact('job-one', 'progress.json'));
  assert.equal(progress.state, 'completed');
  assert.match(await fixture.readArtifact('job-one', 'events.jsonl'), /tool\/result/);
});

test('soft budget steers a wrap-up before the hard step limit', async t => {
  const fixture = await startFixture(t, {
    config: {wrapUpSteps: 4, defaultMaxSteps: 12},
    script: async ({push, stopRequested, sleep, steers}) => {
      for (let step = 1; step <= 30; step++) {
        if (stopRequested()) return;
        push('step/start', {turn: 1, step});
        push('assistant/message', {turn: 1, step, message: {content: [{type: 'text', text: `step ${step}`}]}});
        push('step/end', {turn: 1, step});
        // Keep the soft-budget boundary observable even on a busy CI runner.
        if (step === 8) await until(() => Promise.resolve(steers()), values => values.some(text => text.includes('预算提醒')));
        if (steers().some(text => text.includes('预算提醒'))) {
          push('assistant/message', {turn: 1, step, message: {content: [{type: 'text', text: '收尾\n```bridge-result\n{"outcome":"partial","summary":"预算内收尾","blockers":["未跑完整测试"],"changes":[],"verification":[]}\n```'}]}});
          return;
        }
        await sleep(10);
      }
    },
  });
  await submitTask(fixture.root, {id: 'budget', cwd: fixture.root, goal: 'g', plan: ['p'], acceptance: ['a'], maxSteps: 12, wrapUpSteps: 4, wrapUpSeconds: 0, timeoutSeconds: 60}, fixture.config);
  const status = await until(() => fixture.readStatus('budget'), s => ['completed', 'step_limit'].includes(s.state));
  assert.ok(fixture.fake.state.steers.length >= 1, 'expected a wrap-up steer');
  assert.match(fixture.fake.state.steers[0].text, /预算提醒/);
  const result = JSON.parse(await fixture.readArtifact('budget', 'result.json'));
  assert.equal(result.outcome, 'partial');
  assert.match(result.summary, /收尾/);
  assert.match(await fixture.readArtifact('budget', 'journal.ndjson'), /"kind":"wrapup"/);
  assert.equal(status.outcome, 'partial');
});

test('steer delivers a mid-turn instruction and is journaled', async t => {
  const fixture = await startFixture(t, {
    config: { clientTimeZone: 'America/New_York' },
    script: async ({push, sleep, stopRequested}) => {
      for (let step = 1; step <= 60; step++) {
        if (stopRequested()) return;
        push('step/start', {turn: 1, step});
        push('assistant/message', {turn: 1, step, message: {content: [{type: 'text', text: `working ${step}`}]}});
        push('step/end', {turn: 1, step});
        await sleep(20);
      }
    },
  });
  await submitTask(fixture.root, {id: 'steerable', cwd: fixture.root, goal: 'g', plan: ['p'], acceptance: ['a'], maxSteps: 40, wrapUpSteps: 0, timeoutSeconds: 60}, fixture.config);
  await until(() => fixture.readStatus('steerable'), s => s.state === 'running');
  await steerJob(fixture.root, 'steerable', '只修 search.py，别动 CLI parser');
  await until(() => Promise.resolve(fixture.fake.state.steers.length), length => length >= 1);
  assert.match(fixture.fake.state.steers[0].text, /search\.py/);
  assert.equal(fixture.fake.state.prompts.filter(p => p.mode === 'steer').length, 1);
  assert.ok(fixture.fake.state.prompts.every(p => p.clientTimeZone === 'America/New_York'));
  const journal = await until(() => fixture.readArtifact('steerable', 'journal.ndjson'), text => text.includes('"k":"steer"'));
  assert.match(journal, /"mode":"steer"/);
  await fs.writeFile(path.join(fixture.root, 'jobs', 'steerable', 'cancel'), 'test');
  await until(() => fixture.readStatus('steerable'), s => s.state === 'cancelled');
});

test('repair resumes the same session; fork is the fallback after a restart', async t => {
  const fixture = await startFixture(t);
  await submitTask(fixture.root, {id: 'rework', cwd: fixture.root, goal: 'g', plan: ['p'], acceptance: ['a']}, fixture.config);
  const first = await until(() => fixture.readStatus('rework'), s => s.state === 'completed');
  const sessionId = first.sessionId;

  await repairJob(fixture.root, 'rework', '报告还是 DRAFT，补齐验证');
  const second = await until(() => fixture.readStatus('rework'), s => s.state === 'completed' && s.attempt === 2);
  assert.equal(second.sessionId, sessionId, 'same session should be reused');
  assert.equal(second.sessionMode, 'same');
  const prompt = fixture.fake.state.prompts.at(-1);
  assert.match(prompt.text, /报告还是 DRAFT/);
  assert.equal(prompt.mode, 'queue');
  assert.ok((await fs.readdir(path.join(fixture.root, 'jobs', 'rework', 'attempts', '1'))).includes('result.json'));

  fixture.fake.state.agents.delete(sessionId);
  await repairJob(fixture.root, 'rework', '再补一次');
  const third = await until(() => fixture.readStatus('rework'), s => s.state === 'completed' && s.attempt === 3);
  assert.equal(fixture.fake.state.forks, 1);
  assert.equal(third.sessionMode, 'fork');
  assert.notEqual(third.sessionId, sessionId);
});

test('needs_input parks the job until Codex answers, then continues in the same session', async t => {
  const fixture = await startFixture(t, {
    script: async ({push, text}) => {
      const asking = !text.includes('【Codex 回答】');
      push('step/start', {turn: 1, step: 1});
      push('assistant/message', {turn: 1, step: 1, message: {content: [{type: 'text', text: asking
        ? '需要决策\n```bridge-result\n{"outcome":"needs_input","summary":"等待选择","questions":["保留旧引号语义还是改成字节等价？"],"changes":[],"verification":[]}\n```'
        : '继续完成\n```bridge-result\n{"outcome":"completed","summary":"按回答完成","changes":[],"verification":[]}\n```'}]}});
      push('step/end', {turn: 1, step: 1});
    },
  });
  await submitTask(fixture.root, {id: 'asking', cwd: fixture.root, goal: 'g', plan: ['p'], acceptance: ['a']}, fixture.config);
  const parked = await until(() => fixture.readStatus('asking'), s => s.state === 'needs_input');
  assert.equal(parked.pendingQuestion.questions.length, 1);
  const health = await until(() => fixture.readHealth(), h => h.waitingInput?.length === 1);
  assert.equal(health.waitingInput[0].id, 'asking');

  await answerQuestion(fixture.root, 'asking', '保留旧引号语义，只做 Unicode 分隔符修复');
  const done = await until(() => fixture.readStatus('asking'), s => s.state === 'completed' && s.attempt === 2);
  assert.equal(done.sessionId, parked.sessionId);
  assert.ok(fixture.fake.state.prompts.some(p => p.text.includes('【Codex 回答】')), 'answer must reach the session');
  assert.match(done.summary, /按回答完成/);
});

test('dependsOn gates on acceptance and blocks on failed dependencies', async t => {
  const fixture = await startFixture(t, {config: {maxConcurrent: 2}});
  await submitTask(fixture.root, {id: 'dep-a', cwd: fixture.root, goal: 'a', plan: ['p'], acceptance: ['a']}, fixture.config);
  await submitTask(fixture.root, {id: 'dep-b', cwd: fixture.root, goal: 'b', plan: ['p'], acceptance: ['a'], dependsOn: ['dep-a']}, fixture.config);
  await until(() => fixture.readStatus('dep-a'), s => s.state === 'completed');
  const waiting = await until(() => fixture.readStatus('dep-b'), s => /等待 Codex 验收/.test(s.waitingReason ?? ''));
  assert.equal(waiting.state, 'queued');
  assert.equal(fixture.fake.state.created.length, 1, 'dependent must not start before acceptance');

  await reviewJob(fixture.root, 'dep-a', 'accepted', '独立复算通过');
  await until(() => fixture.readStatus('dep-b'), s => s.state === 'completed');

  await submitTask(fixture.root, {id: 'dep-c', cwd: fixture.root, goal: 'c', plan: ['p'], acceptance: ['a'], dependsOn: ['dep-missing']}, fixture.config);
  const pendingDep = await until(() => fixture.readStatus('dep-c'), s => /尚未创建/.test(s.waitingReason ?? ''));
  assert.equal(pendingDep.state, 'queued');
});

test('maxConcurrent runs slots in parallel and health reports them', async t => {
  const mkdir = fs.mkdir;
  t.mock.method(fs, 'mkdir', async (directory, ...args) => {
    if (String(directory).endsWith(path.join('attempts', '1'))) await pause(150);
    return mkdir(directory, ...args);
  });
  const fixture = await startFixture(t, {
    config: {maxConcurrent: 2},
    script: async ({push, sleep, stopRequested}) => {
      for (let step = 1; step <= 40; step++) {
        if (stopRequested()) return;
        push('step/start', {turn: 1, step});
        push('assistant/message', {turn: 1, step, message: {content: [{type: 'text', text: `busy ${step}`}]}});
        push('step/end', {turn: 1, step});
        await sleep(25);
      }
    },
  });
  for (const id of ['par-1', 'par-2', 'par-3']) {
    await submitTask(fixture.root, {id, cwd: fixture.root, goal: id, plan: ['p'], acceptance: ['a'], maxSteps: 40, wrapUpSteps: 0, timeoutSeconds: 30}, fixture.config);
  }
  const health = await until(() => fixture.readHealth(), h => h.activeCount === 2);
  assert.equal(health.activeTasks.length, 2);
  assert.equal(health.queued, 1, 'third task must stay queued in the inbox');
  assert.deepEqual(health.queuedIds, ['par-3']);
  const statuses = await until(() => Promise.all(['par-1', 'par-2'].map(id => fixture.readStatus(id))), all => all.every(s => s.state === 'running'));
  assert.deepEqual(statuses.map(s => s.state), ['running', 'running']);
  for (const id of ['par-1', 'par-2']) await fs.writeFile(path.join(fixture.root, 'jobs', id, 'cancel'), 'test');
  await until(async () => Promise.all(['par-1', 'par-2'].map(id => fixture.readStatus(id))), all => all.every(s => s.state === 'cancelled'));
});

test('digest renders a machine-checkable review pack', () => {
  const text = renderDigest({
    status: {id: 'j', state: 'step_limit', steps: 150, maxSteps: 150, attempt: 1, outcome: 'partial', review: {state: 'pending'}, sessionId: 'session-1'},
    progress: {step: 150, phase: 'finished'},
    result: {structured: true, outcome: 'partial', summary: '部分完成', changes: [{path: '/a', kind: 'edit', note: 'x'}], verification: [{command: 'pytest', exitCode: 0, result: 'ok'}], blockers: ['未跑覆盖率'], questions: [], next: []},
    evidence: {files: [{path: '/a', kinds: ['edit'], sha256: 'a'.repeat(64), bytes: 12, inWriteScope: false}], commands: [{step: 1, command: 'pytest', exitCode: 0}], denials: [], steers: [], wrapUps: 1},
    journalTail: [{k: 'state', state: 'step_limit'}],
    paths: {events: '/e', journal: '/j', task: '/t', result: '/r', evidence: '/v'},
  });
  assert.match(text, /任务 j 审查包/);
  assert.match(text, /⚠越界/);
  assert.match(text, /独立证据/);
  assert.match(text, /未跑覆盖率/);
  assert.match(text, /深挖路径/);
});

test('stale running job is interrupted and never replayed', async t => {
  const root = await tempRoot(t, 'dsh-bridge-recovery-');
  await fs.mkdir(path.join(root, 'jobs/old'), {recursive: true});
  await fs.writeFile(path.join(root, 'jobs/old/status.json'), JSON.stringify({id: 'old', state: 'running'}));
  const fake = makeFake();
  const {startBridge} = await import('../worker.js');
  const stop = await startBridge(fake.ctx, root, 20);
  t.after(async () => { await stop().catch(() => {}); await fs.rm(root, {recursive: true, force: true}).catch(() => {}); });
  const job = JSON.parse(await fs.readFile(path.join(root, 'jobs/old/status.json'), 'utf8'));
  assert.equal(job.state, 'interrupted');
  assert.equal(fake.state.created.length, 0);
  await assert.rejects(startBridge(fake.ctx, root, 20), /already running/);
});

test('real harness payload shape: tool/result carries message.toolCallId', () => {
  const meta = resultMeta({data: {turn: 1, step: 1, message: {role: 'tool', toolCallId: 'call_abc', content: [{type: 'text', text: 'ok\n[exit code: 0]'}]}}});
  assert.equal(meta.callId, 'call_abc');
  assert.equal(meta.exitCode, 0);
  assert.equal(meta.isError, false);
  const denied = resultMeta({data: {message: {toolCallId: 'call_x', content: [{type: 'text', text: 'Error: the user rejected tool "bash"'}], isError: true}}});
  assert.equal(denied.isError, true);
});

test('paths are canonicalized so symlinked temp dirs (/var → /private/var) do not break writeScope', async t => {
  const root = await tempRoot(t);
  const real = canonicalPathSync(root);
  assert.equal(real, await fs.realpath(root), `unexpected canonical path ${real}`);

  // scope 用未解析的 /var 形式、目标用解析后的形式（真机上真实出现过的组合）
  assert.equal(writeScopeAllows([root], path.join(real, 'a.txt')), true);
  assert.equal(writeScopeAllows([real], path.join(root, 'a.txt')), true);
  assert.equal(writeScopeAllows([root], path.join(real, '..', 'elsewhere', 'a.txt')), false);

  // 目录软链也要能识别
  const link = path.join(root, 'linkdir');
  const target = path.join(root, 'realdir');
  await fs.mkdir(target, {recursive: true});
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(writeScopeAllows([link], path.join(target, 'file.txt')), true);
  assert.equal(writeScopeAllows([target], path.join(link, 'file.txt')), true);

  // 验收：不存在的新文件路径也要能规范化
  assert.equal(canonicalPathSync(path.join(root, 'not', 'yet', 'x.txt')), path.join(real, 'not', 'yet', 'x.txt'));
});

test('bash write targets are detected so the scope guard cannot be bypassed with a redirect', async () => {
  const {bashWriteTargets} = await import('../protocol.js');
  assert.deepEqual(bashWriteTargets("printf 'escaped' > /outside/escaped.txt"), ['/outside/escaped.txt']);
  assert.deepEqual(bashWriteTargets('echo hi >> "out file.txt"'), ['out file.txt']);
  assert.deepEqual(bashWriteTargets('cmd 2>&1 | tee -a log.txt'), ['log.txt']);
  assert.deepEqual(bashWriteTargets('grep ">" file.txt'), [], '引号里的 > 不是重定向');
  assert.deepEqual(bashWriteTargets('cat a > /dev/null'), [], '/dev/* 不算越界目标');
  assert.deepEqual(bashWriteTargets('rm -rf /outside/dir'), ['/outside/dir']);
  assert.deepEqual(bashWriteTargets('cp a.txt /outside/b.txt'), ['/outside/b.txt']);
  assert.deepEqual(bashWriteTargets('dd if=/dev/zero of=/outside/img bs=1k count=1'), ['/outside/img']);
  assert.deepEqual(bashWriteTargets('sed -i s/a/b/ /outside/file.txt'), ['/outside/file.txt']);
  assert.deepEqual(bashWriteTargets('cd /tmp && ls -la'), [], '只读命令没有写入目标');
});

test('guard denies bash writes outside writeScope for bridge sessions', () => {
  const sessionId = 'session-bash-guard';
  activeSessions.set(sessionId, {jobId: 'j', cwd: '/work', writeScope: ['/work']});
  const exec = args => ({name: 'bash', arguments: JSON.stringify(args), agent: {session: {id: sessionId}}});
  assert.equal(writeScopeGuard(exec({command: 'echo ok > /work/out.txt'})), undefined);
  assert.match(writeScopeGuard(exec({command: "printf 'x' > /outside/escaped.txt"})), /超出任务 writeScope/);
  assert.match(writeScopeGuard(exec({command: 'rm -rf /outside'})), /超出任务 writeScope/);
  assert.equal(writeScopeGuard(exec({command: 'grep -r needle /outside'})), undefined, '只读访问不受限');
  activeSessions.delete(sessionId);
});

test('PowerShell write targets preserve Windows paths and named destinations', async () => {
  const { powershellWriteTargets } = await import('../protocol.js');
  assert.deepEqual(powershellWriteTargets(String.raw`Set-Content -LiteralPath 'C:\项目 空格\out.txt' -Value 'hello'`), [String.raw`C:\项目 空格\out.txt`]);
  assert.deepEqual(powershellWriteTargets(String.raw`'hello' | Out-File -FilePath 'D:\output\out.txt' -Encoding utf8`), [String.raw`D:\output\out.txt`]);
  assert.deepEqual(powershellWriteTargets('Copy-Item -Path input.txt -Destination ../outside.txt'), ['../outside.txt']);
  assert.deepEqual(powershellWriteTargets('Set-Content out.txt hello; Add-Content -Path log.txt -Value again'), ['out.txt', 'log.txt']);
  assert.deepEqual(powershellWriteTargets('Remove-Item -LiteralPath ../outside -Recurse; New-Item -Path allowed/new.txt -ItemType File'), ['../outside', 'allowed/new.txt']);
  assert.deepEqual(powershellWriteTargets('Get-Content ../outside; Get-ChildItem ../outside'), []);
  assert.deepEqual(powershellWriteTargets('Write-Output "hello" > "out file.txt"'), ['out file.txt']);
  assert.deepEqual(powershellWriteTargets("Set-Content -Path 'allowed/in.txt', '../outside.txt' -Value hi"), ['allowed/in.txt', '../outside.txt']);
  assert.deepEqual(powershellWriteTargets('New-Item -Name ../outside.txt -ItemType File'), [path.normalize('../outside.txt')]);
  assert.deepEqual(powershellWriteTargets("Set-Content -Path 'out,comma.txt' -Value hi"), ['out,comma.txt']);
});

test('guard uses native absolute paths and PowerShell write targets', async t => {
  const root = await tempRoot(t);
  const sessionId = 'session-pwsh-guard';
  const allowed = path.join(root, '项目 空格');
  await fs.mkdir(allowed);
  activeSessions.set(sessionId, {jobId: 'j', cwd: root, writeScope: [allowed]});
  t.after(() => activeSessions.delete(sessionId));
  const exec = (name, args) => ({name, arguments: JSON.stringify(args), agent: {session: {id: sessionId}}});
  assert.equal(writeScopeGuard(exec('write', {file_path: path.join(allowed, 'file.txt')})), undefined);
  assert.equal(writeScopeGuard(exec('pwsh', {command: `Set-Content -LiteralPath '${path.join(allowed, 'file.txt')}' -Value hello`})), undefined);
  assert.match(writeScopeGuard(exec('pwsh', {command: `Set-Content -LiteralPath '${path.join(root, 'outside.txt')}' -Value hello`})), /超出任务 writeScope/);
  assert.match(writeScopeGuard(exec('powershell', {command: 'Copy-Item in.txt -Destination ../outside.txt'})), /超出任务 writeScope/);
  assert.match(writeScopeGuard(exec('pwsh', {command: "Set-Content -Path '项目 空格/in.txt', '../outside.txt' -Value hi"})), /超出任务 writeScope/);
  if (process.platform === 'win32') {
    assert.equal(writeScopeAllows([allowed.toUpperCase()], path.join(allowed.toLowerCase(), 'new.txt')), true);
    assert.equal(writeScopeAllows([allowed], 'Z:\\outside.txt'), false);
  }
});
