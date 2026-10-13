#!/usr/bin/env node
// 以 Codex 的真实调用方式验证 MCP 通道：启动 mcp.mjs（stdio JSON-RPC），
// 走 health → submit → wait(阻塞) → steer → wait → digest → review 全序列。
//
//   node scripts/mcp-e2e.mjs
// 退出码：0 全绿；1 有失败；2 前置条件不满足（插件未在线/版本不对）。

import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_ROOT, REVIEWABLE_STATES} from '../protocol.js';
import {parseOptions, resolvePath} from './deployment-options.mjs';

const flags = parseOptions(process.argv.slice(2), {boolean: ['--help'], value: ['--root']});
if (flags['--help']) {
  console.log('Usage: node scripts/mcp-e2e.mjs [--root PATH]\nRuns a live DSH model task through the local stdio MCP server.');
  process.exit(0);
}
const bridgeRoot = resolvePath(flags['--root'] ?? DEFAULT_ROOT);

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'mcp.mjs');
const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

const child = spawn(process.execPath, [server], {stdio: ['pipe', 'pipe', 'inherit'], env: {...process.env, DSH_CODEX_BRIDGE_ROOT: bridgeRoot}});
let buffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  }
});

let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 600_000);
});
const tool = async (name, args) => {
  const response = await rpc('tools/call', {name, arguments: args});
  if (response.error) throw new Error(`${name}: ${response.error.message}`);
  const text = response.result.content?.[0]?.text ?? '';
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return {isError: response.result.isError === true, text, data};
};

const work = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-e2e-')));
const id = `mcp-e2e-${Date.now().toString(36)}`;
console.log(`工作目录：${work}\n任务 id：${id}\n`);

const init = await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}});
check('initialize 成功', init.result?.serverInfo?.name === 'dsh-codex-bridge', String(JSON.stringify(init.error ?? init.result) ?? '').slice(0, 120));

const health = await tool('bridge_health', {});
check('bridge_health 在线且 version=2', health.data?.alive === true && health.data?.version === 2, health.text.slice(0, 120));
if (health.data?.alive !== true || health.data?.version !== 2) { console.log('\n插件未就绪，测试中止。'); child.kill(); process.exit(2); }

const submitted = await tool('bridge_submit', {task: {
  id, cwd: work,
  goal: '在本工作目录创建 mcp.txt，内容为 mcp-ok，然后结束。',
  plan: ['写 mcp.txt', '确认内容'],
  acceptance: ['mcp.txt 内容为 mcp-ok'],
  boundaries: '只写本工作目录',
  writeScope: [work],
  maxSteps: 10, wrapUpSteps: 3, timeoutSeconds: 240,
}});
check('bridge_submit 接受任务', submitted.isError === false && submitted.text.includes(id), submitted.text.slice(0, 160));

let waited = await tool('bridge_wait', {id, timeoutSeconds: 50});
check('bridge_wait 阻塞后返回快照', Boolean(waited.data?.state), waited.text.slice(0, 160));
console.log(`  第一次 wait：state=${waited.data?.state} terminal=${waited.data?.terminal}`);

if (waited.data?.terminal !== true) {
  const steered = await tool('bridge_steer', {id, text: '保持最小改动：先写文件，再一句话汇报。'});
  check('bridge_steer 中途指令被接受', steered.isError === false, steered.text.slice(0, 160));
  for (let i = 0; i < 14 && waited.data?.terminal !== true; i++) {
    if (waited.data?.requests?.length) break;
    waited = await tool('bridge_wait', {id, timeoutSeconds: 50});
    console.log(`  第 ${i + 2} 次 wait：state=${waited.data?.state} terminal=${waited.data?.terminal}`);
  }
}
check('任务到达终态', waited.data?.terminal === true, `state=${waited.data?.state}`);
check('任务状态可验收', REVIEWABLE_STATES.has(waited.data?.state), `state=${waited.data?.state}`);
const pendingRequests = await tool('bridge_requests', {jobId: id});
check('本任务没有待处理能力请求', pendingRequests.isError === false && Array.isArray(pendingRequests.data) && pendingRequests.data.length === 0,
  Array.isArray(pendingRequests.data) ? pendingRequests.data.map(request => request.id).join(', ') : '无法读取请求列表');

const digest = await tool('bridge_digest', {id});
const evidence = digest.data?.evidence;
check('bridge_digest 返回交付结论', Boolean(digest.data?.result?.outcome), digest.text.slice(0, 160));
check('bridge_digest 带独立证据', Array.isArray(evidence?.files) && evidence.files.length > 0, JSON.stringify(evidence?.files ?? []).slice(0, 120));
const content = await fs.readFile(path.join(work, 'mcp.txt'), 'utf8').catch(() => null);
check('产物内容正确', (content ?? '').trim() === 'mcp-ok', String(content).slice(0, 40));

const reviewed = await tool('bridge_review', {id, verdict: failures.length ? 'changes_requested' : 'accepted', note: failures.length ? `mcp-e2e缺口：${failures.join('；')}` : 'mcp-e2e：产物内容与证据已校验'});
check('bridge_review 记录成功', reviewed.isError === false, reviewed.text.slice(0, 160));

child.kill();
console.log(`\n${failures.length ? `失败 ${failures.length} 项：${failures.join('；')}` : 'MCP 通道全绿'}`);
console.log(`证据目录：${path.join(bridgeRoot, 'jobs', id)}`);
process.exit(failures.length ? 1 : 0);
