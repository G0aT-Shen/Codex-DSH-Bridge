#!/usr/bin/env node
// 真机冒烟：验证桌面 DSH 已加载 v2 插件，并跑通「派工 → 长轮询 → 结构化交付 → 证据 → 同会话返工」。
//
//   node scripts/smoke-v2.mjs            快速冒烟（预算收紧，验证软预算与交付结构）
//   node scripts/smoke-v2.mjs --full     额外验证 steer 与 repair 续跑
//
// 退出码：0 = 通过；1 = 失败；2 = 插件未在线/不是 v2。

import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execute} from '../cli.mjs';
import {DEFAULT_ROOT, REVIEWABLE_STATES} from '../protocol.js';
import {parseOptions, resolvePath} from './deployment-options.mjs';

const flags = parseOptions(process.argv.slice(2), {boolean: ['--full', '--help'], value: ['--root']});
if (flags['--help']) {
  console.log('Usage: node scripts/smoke-v2.mjs [--full] [--root PATH]\nRuns a live DSH model task. --full also verifies same-session repair.');
  process.exit(0);
}
const full = flags['--full'];
const bridgeRoot = resolvePath(flags['--root'] ?? DEFAULT_ROOT);
const log = (...parts) => console.log(...parts);
const failures = [];

async function call(argv) {
  const {exitCode, stdout} = await execute(argv, {root: bridgeRoot});
  let data;
  try { data = JSON.parse(stdout); } catch { data = undefined; }
  return {exitCode, stdout, data};
}

async function waitForTerminal(timeoutSeconds = 240) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const changes = [];
  let result;
  do {
    result = await call(['watch', id, '--timeout', String(Math.min(50, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)))), '--json']);
    changes.push(...(result.data?.changes ?? []));
    if (result.data?.terminal || result.data?.requests?.length) break;
  } while (Date.now() < deadline);
  if (result.data) result.data.changes = changes;
  return result;
}

function check(label, condition, detail = '') {
  if (condition) log(`  ✔ ${label}`);
  else { failures.push(label); log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function checkNoPendingRequests() {
  const pending = await call(['requests', id, '--json']);
  check('本任务没有待处理能力请求', pending.exitCode === 0 && Array.isArray(pending.data) && pending.data.length === 0,
    Array.isArray(pending.data) ? pending.data.map(request => request.id).join(', ') : '无法读取请求列表');
}

const work = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-smoke-')));
const id = `smoke-v2-${Date.now().toString(36)}`;
log(`工作目录：${work}\n任务 id：${id}\n`);

log('1) health');
const health = await call(['health', '--json']);
check('bridge 在线', health.data?.alive === true, health.stdout.slice(0, 120));
check('插件版本为 2', health.data?.version === 2, `version=${health.data?.version}（需要重启 DSH 或重新启用插件）`);
if (!health.data?.alive || health.data?.version !== 2) {
  log('\n插件未就绪，冒烟中止。');
  process.exit(2);
}

log('2) submit（收紧预算以验证软预算收尾）');
const submitted = await call(['submit', '--inline', JSON.stringify({
  id,
  cwd: work,
  goal: '创建 smoke.txt（内容 "bridge v2 ok"）与 report.md（记录实际命令与结果），然后结束。',
  plan: ['写 smoke.txt', '写 report.md', '报告实际命令与结果'],
  acceptance: ['smoke.txt 内容为 bridge v2 ok', 'report.md 存在且含实际命令'],
  boundaries: '只允许写入本工作目录；不联网、不安装、不提交',
  authorization: {network: false, install: false, commit: false},
  writeScope: [work],
  maxSteps: 14,
  wrapUpSteps: 4,
  timeoutSeconds: 300,
})]);
check('提交被接受', submitted.exitCode === 0, submitted.stdout.slice(0, 200));

log('3) watch（长轮询，不忙轮询）');
const started = Date.now();
const watched = await waitForTerminal();
const state = watched.data?.state ?? 'unknown';
let reviewState = state;
check('任务到达终态', watched.data?.terminal === true, `state=${state}`);
check('任务状态可验收', REVIEWABLE_STATES.has(state), `state=${state}`);
await checkNoPendingRequests();
check('有中间状态变化记录', Array.isArray(watched.data?.changes) && watched.data.changes.length >= 1);
log(`  终态=${state}，耗时 ${Math.round((Date.now() - started) / 1000)}s，review=${watched.data?.review}`);

log('4) digest / 产物');
const digest = await call(['digest', id, '--json']);
const result = digest.data?.result;
const evidence = digest.data?.evidence;
check('result.json 存在且有 outcome', Boolean(result?.outcome), String(JSON.stringify(result) ?? '').slice(0, 160));
check('evidence.json 有文件哈希', (evidence?.files ?? []).some(f => typeof f.sha256 === 'string' && f.sha256.length === 64));
check('journal 有工具证据', (digest.data?.journal ?? []).length > 0);
check('发生了真实文件改动', (evidence?.files ?? []).length > 0);
const smokeFile = path.join(work, 'smoke.txt');
const content = await fs.readFile(smokeFile, 'utf8').catch(() => null);
check('smoke.txt 内容正确', (content ?? '').trim() === 'bridge v2 ok', String(content).slice(0, 60));
const reportFile = path.join(work, 'report.md');
const reportContent = await fs.readFile(reportFile, 'utf8').catch(() => null);
check('report.md 存在且非空', typeof reportContent === 'string' && reportContent.trim().length > 0);
const progress = JSON.parse(await fs.readFile(path.join(bridgeRoot, 'jobs', id, 'progress.json'), 'utf8').catch(() => '{}'));
check('progress.json 记录了终态', progress.state === state);

if (full && REVIEWABLE_STATES.has(state)) {
  log('5) steer（运行中干预能力已由单测覆盖；真机这里只验证修复通道）');
  log('6) repair（同一会话续跑：attempt 2 且 sessionId 不变）');
  const before = JSON.parse(await fs.readFile(path.join(bridgeRoot, 'jobs', id, 'status.json'), 'utf8'));
  const repaired = await call(['repair', id, '在 report.md 末尾追加一行 "review: rework round 2"，其余不要改。']);
  check('repair 被接受', repaired.exitCode === 0, repaired.stdout.slice(0, 160));
  // repair queues a signal; don't mistake the previous terminal attempt for the new one.
  const resumeDeadline = Date.now() + 15000;
  while (Date.now() < resumeDeadline) {
    const current = await call(['status', id, '--json']);
    if (current.data?.attempt > before.attempt) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const second = await waitForTerminal();
  const after = JSON.parse(await fs.readFile(path.join(bridgeRoot, 'jobs', id, 'status.json'), 'utf8'));
  check('attempt 递增到 2', after.attempt >= 2, `attempt=${after.attempt}`);
  check('复用同一会话', after.sessionId === before.sessionId, `before=${before.sessionId} after=${after.sessionId}`);
  check('第二次也到达终态', second.data?.terminal === true, `state=${second.data?.state}`);
  reviewState = after.state;
  check('返工后的任务状态可验收', REVIEWABLE_STATES.has(reviewState), `state=${reviewState}`);
  await checkNoPendingRequests();
  const repairedReport = await fs.readFile(reportFile, 'utf8').catch(() => null);
  check('report.md 已追加返工标记', repairedReport?.includes('review: rework round 2') === true);
  const archived = await fs.readdir(path.join(bridgeRoot, 'jobs', id, 'attempts', '1')).catch(() => []);
  check('第一次尝试已归档', archived.includes('result.json'));
}

log('\n7) 审查记录');
const verdict = failures.length ? 'changes_requested' : 'accepted';
const review = await call(['review', id, verdict, failures.length ? `真机冒烟缺口：${failures.join('；')}` : `真机冒烟：${reviewState}，产物与证据已由 smoke-v2.mjs 校验`]);
check(`review ${verdict} 记录成功`, review.exitCode === 0, review.stdout.slice(0, 160));

log(`\n${failures.length ? `失败 ${failures.length} 项：${failures.join('；')}` : '全部通过'}`);
log(`证据目录：${path.join(bridgeRoot, 'jobs', id)}`);
process.exit(failures.length ? 1 : 0);
