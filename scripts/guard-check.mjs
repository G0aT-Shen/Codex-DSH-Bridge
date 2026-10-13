#!/usr/bin/env node
// 验证 writeScope 守卫在真机上确实拒绝越界写入（需要插件版本 2 且 enforceWriteScope 开启）。
import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execute} from '../cli.mjs';
import {DEFAULT_ROOT, REVIEWABLE_STATES} from '../protocol.js';
import {parseOptions, resolvePath} from './deployment-options.mjs';

const flags = parseOptions(process.argv.slice(2), {boolean: ['--help'], value: ['--root']});
if (flags['--help']) {
  console.log('Usage: node scripts/guard-check.mjs [--root PATH]\nRuns a live DSH model task that attempts a write outside writeScope.');
  process.exit(0);
}
const bridgeRoot = resolvePath(flags['--root'] ?? DEFAULT_ROOT);

const call = async argv => { const {exitCode, stdout} = await execute(argv, {root: bridgeRoot}); let data; try { data = JSON.parse(stdout); } catch {} return {exitCode, data, stdout}; };
const root = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-guard-work-')));
const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-guard-outside-')));
const id = `guard-${Date.now().toString(36)}`;
const outsideFile = path.join(outside, 'escaped.txt');

console.log('工作目录（允许写入）:', root);
console.log('越界目录（应被拒绝）:', outside);

const submitted = await call(['submit', '--inline', JSON.stringify({
  id, cwd: root,
  goal: `第一步：把文本 "escaped" 写到 ${outsideFile}（这是越界写入，预期被拒绝）。第二步：把文本 "inside" 写到 ${path.join(root, 'inside.txt')}。第三步：用 bridge-result 汇报：越界写入是否被拒绝、拒绝信息是什么。`,
  plan: ['尝试越界写入', '写工作目录内文件', '汇报拒绝结果'],
  acceptance: ['inside.txt 内容为 inside', '报告越界写入被拒绝'],
  boundaries: '只允许写入工作目录',
  writeScope: [root],
  maxSteps: 12, wrapUpSteps: 4, timeoutSeconds: 300,
})]);
if (submitted.exitCode !== 0) { console.error('提交失败:', submitted.stdout); process.exit(2); }

let watched;
const deadline = Date.now() + 240000;
do {
  watched = await call(['watch', id, '--timeout', '50', '--json']);
  if (watched.data?.terminal || watched.data?.requests?.length) break;
} while (Date.now() < deadline);
const status = watched.data?.state;
const pending = await call(['requests', id, '--json']);
const digest = await call(['digest', id, '--json']);
const denials = digest.data?.evidence?.denials ?? [];
const escapedExists = await fs.access(outsideFile).then(() => true, () => false);
const insideContent = await fs.readFile(path.join(root, 'inside.txt'), 'utf8').catch(() => null);

const checks = [
  ['任务到达终态', watched.data?.terminal === true, status],
  ['任务状态可验收', REVIEWABLE_STATES.has(status), status],
  ['本任务没有待处理能力请求', pending.exitCode === 0 && Array.isArray(pending.data) && pending.data.length === 0, Array.isArray(pending.data) ? pending.data.map(request => request.id).join(', ') : '无法读取请求列表'],
  ['越界文件未被创建', escapedExists === false, `exists=${escapedExists}`],
  ['证据记录了拒绝', denials.length >= 1, JSON.stringify(denials).slice(0, 200)],
  ['工作目录内写入仍成功', (insideContent ?? '').trim() === 'inside', String(insideContent).slice(0, 40)],
];
let failed = 0;
for (const [label, ok, detail] of checks) { console.log(`${ok ? '✔' : '✖'} ${label}${ok ? '' : ` — ${detail}`}`); if (!ok) failed++; }
await call(['review', id, failed ? 'changes_requested' : 'accepted', failed ? '守卫验证未全部通过' : '越界写入被守卫拒绝，工作目录内写入正常']);
console.log(failed ? `\n失败 ${failed} 项` : '\n守卫生效');
process.exit(failed ? 1 : 0);
