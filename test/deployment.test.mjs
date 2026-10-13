import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { tempRoot } from './helpers.mjs';
import { installShared } from '../scripts/install-shared.mjs';
import { installSkills } from '../scripts/install-skills.mjs';
import { codexInvocation, parseOptions } from '../scripts/deployment-options.mjs';
import { verifyShared } from '../scripts/verify-shared.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalPatch = `# Existing profile must keep its tags and settings.
- id: user-plugin
  name: example-user-plugin
  config:
    credential: !env SYNTHETIC_TEST_ENV
    preference: retained
- insert:
    - id: another-plugin
      name: example-other-plugin
      config: { enabled: true }
`;

async function fixture(t, { packages = true, patch = originalPatch } = {}) {
  const root = await tempRoot(t, 'dsh-deploy-中文 空格-');
  const project = path.join(root, '仓库 project with spaces');
  const profile = path.join(root, 'desktop profile 桌面');
  const userHome = path.join(root, 'user home 用户');
  await fs.mkdir(path.join(project, 'shared-plugin'), { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(project, 'cli.mjs'), 'export function main() { console.log("portable cli ok"); }\n');
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'desktop-test', dependencies: { 'user-plugin': '^1.0.0' }, provider: { untouched: true }, env: { SYNTHETIC_TEST_ENV: 'synthetic-secret-do-not-print' } }, null, 2) + '\n');
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), patch);
  if (packages) for (const name of ['dsh-skill-filesystem', 'dsh-hmr', 'dsh-mcp-client']) {
    const directory = path.join(profile, 'node_modules', '@deepseek-ai', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, main: 'index.js' }));
    await fs.writeFile(path.join(directory, 'index.js'), 'module.exports = {};\n');
  }
  for (const name of ['codex-dsh-shared', 'dsh-orchestrator']) {
    const directory = path.join(project, 'skills', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\nCLI: {{BRIDGE_REPO}}/cli.mjs\n`);
  }
  return { root, project, profile, userHome, codexHome: path.join(userHome, '.codex') };
}

async function snapshot(directory) {
  const tree = {};
  async function walk(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) tree[next] = { link: await fs.readlink(path.join(current, entry.name)) };
      else if (entry.isDirectory()) { tree[next] = { directory: true }; await walk(path.join(current, entry.name), next); }
      else tree[next] = (await fs.readFile(path.join(current, entry.name))).toString('base64');
    }
  }
  await walk(directory);
  return tree;
}

function entriesFrom(text) { return YAML.parse(text, { logLevel: 'silent' }).flatMap(item => item.insert ?? [item]); }

test('profile dry-run is read-only, has no mandatory MCP and does not print environment values', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const result = await installShared({ ...f, dryRun: true, listMcpServers: () => { throw new Error('must not call Codex'); } });
  assert.deepEqual(await snapshot(f.root), before);
  assert.deepEqual(result.portableMcp, []);
  assert.deepEqual(result.backups, []);
  assert.equal(result.linksToCreate.length, 2);
  assert.ok(result.installed.includes('codex-task-bridge'));
  assert.ok(!JSON.stringify(result).includes('synthetic-secret-do-not-print'));
});

test('profile installation preserves YAML tags, other config and private backups; second apply is a no-op', async t => {
  const f = await fixture(t);
  const result = await installShared(f);
  assert.equal(result.backups.length, 2);
  const pkg = JSON.parse(await fs.readFile(path.join(f.profile, 'package.json')));
  assert.deepEqual(pkg.provider, { untouched: true });
  assert.equal(pkg.env.SYNTHETIC_TEST_ENV, 'synthetic-secret-do-not-print');
  assert.equal(pkg.dependencies['user-plugin'], '^1.0.0');
  const yaml = await fs.readFile(path.join(f.profile, 'cordis.patch.yml'), 'utf8');
  assert.ok(yaml.includes('!env SYNTHETIC_TEST_ENV'));
  assert.ok(yaml.includes('# Existing profile must keep its tags and settings.'));
  assert.equal(entriesFrom(yaml).find(entry => entry.id === 'user-plugin').config.preference, 'retained');
  for (const backup of result.backups) {
    if (backup.startsWith(path.join(f.profile, 'cordis.patch.yml'))) assert.equal(await fs.readFile(backup, 'utf8'), originalPatch);
    if (process.platform !== 'win32') assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
  }
  assert.equal(await fs.realpath(path.join(f.profile, 'node_modules', '@hanyangshen', 'codex-bridge')), await fs.realpath(f.project));
  assert.equal(await fs.realpath(path.join(f.profile, 'node_modules', '@hanyangshen', 'codex-shared')), await fs.realpath(path.join(f.project, 'shared-plugin')));
  const before = await snapshot(f.root);
  const repeated = await installShared(f);
  assert.deepEqual(repeated.changedFiles, []);
  assert.deepEqual(repeated.linksToCreate, []);
  assert.deepEqual(repeated.backups, []);
  assert.deepEqual(await snapshot(f.root), before);
});

test('explicit stdio MCP mirror preserves its environment only in profile configuration', async t => {
  const f = await fixture(t);
  const calls = [];
  const result = await installShared({ ...f, mcpServers: ['lms'], codexBin: 'specified codex', listMcpServers: binary => {
    calls.push(binary);
    return [{ name: 'lms', enabled: true, transport: { type: 'stdio', command: 'node', args: ['server with spaces.mjs'], env: { API_KEY: 'synthetic-mcp-secret' }, cwd: f.root } }];
  } });
  assert.deepEqual(calls, ['specified codex']);
  assert.deepEqual(result.portableMcp, ['lms']);
  assert.ok(!JSON.stringify(result).includes('synthetic-mcp-secret'));
  const mcp = entriesFrom(await fs.readFile(path.join(f.profile, 'cordis.patch.yml'), 'utf8')).find(entry => entry.id === 'codex-shared-mcp-lms');
  assert.deepEqual(mcp.config.env, { API_KEY: 'synthetic-mcp-secret' });
  assert.deepEqual(mcp.config.args, ['server with spaces.mjs']);
  assert.equal(mcp.config.cwd, f.root);
});

test('unavailable MCP and conflicting managed packages fail before modifying a profile', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  await assert.rejects(installShared({ ...f, mcpServers: ['lms'], listMcpServers: () => [{ name: 'lms', enabled: false, transport: { type: 'stdio', command: 'node' } }] }), /unavailable, disabled or not stdio/);
  assert.deepEqual(await snapshot(f.root), before);
  const target = path.join(f.profile, 'node_modules', '@hanyangshen', 'codex-bridge');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'user.txt'), 'keep');
  const conflictBefore = await snapshot(f.root);
  await assert.rejects(installShared(f), /points elsewhere/);
  assert.deepEqual(await snapshot(f.root), conflictBefore);
});

test('missing plugins are reported by dry-run and blocked on apply; --no-hmr skips HMR', async t => {
  const f = await fixture(t, { packages: false });
  const before = await snapshot(f.root);
  const dry = await installShared({ ...f, dryRun: true, hmr: false });
  assert.deepEqual(dry.missingPackages, ['@deepseek-ai/dsh-skill-filesystem']);
  assert.ok(!dry.installed.includes('hmr'));
  await assert.rejects(installShared({ ...f, hmr: false }), /does not download packages/);
  assert.deepEqual(await snapshot(f.root), before);
});

test('managed plugin duplicates are refused; custom queues are shared by both plugins', async t => {
  const f = await fixture(t, { patch: '- id: codex-shared\n  name: "@hanyangshen/codex-shared"\n  config: { queueDir: preserved-queue }\n' });
  await installShared(f);
  const entries = entriesFrom(await fs.readFile(path.join(f.profile, 'cordis.patch.yml'), 'utf8'));
  assert.equal(entries.find(entry => entry.id === 'codex-shared').config.queueDir, 'preserved-queue');
  assert.equal(entries.find(entry => entry.id === 'codex-task-bridge').config.queueDir, 'preserved-queue');
  const queueDir = path.join(f.root, '自定义 queue');
  await installShared({ ...f, queueDir });
  const next = entriesFrom(await fs.readFile(path.join(f.profile, 'cordis.patch.yml'), 'utf8'));
  assert.equal(next.find(entry => entry.id === 'codex-shared').config.queueDir, queueDir);
  assert.equal(next.find(entry => entry.id === 'codex-task-bridge').config.queueDir, queueDir);
  await fs.appendFile(path.join(f.profile, 'cordis.patch.yml'), '- id: codex-shared\n  name: "@hanyangshen/codex-shared"\n  config: {}\n');
  const before = await snapshot(f.root);
  await assert.rejects(installShared(f), /Duplicate managed plugin id/);
  assert.deepEqual(await snapshot(f.root), before);
});

test('Windows UTF-8 BOM packages and existing managed YAML tags are preserved safely', async t => {
  const patch = `- id: codex-shared
  name: '@hanyangshen/codex-shared'
  config:
    userValue: !env SYNTHETIC_CUSTOM_VALUE
    nested: !custom { keep: true }
- id: codex-shared-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs: !append
      - !env SYNTHETIC_SKILL_DIR
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root: !append
      - !env SYNTHETIC_HMR_DIR
`;
  const f = await fixture(t, { patch });
  const packageFile = path.join(f.profile, 'package.json');
  const original = '\uFEFF' + await fs.readFile(packageFile, 'utf8');
  await fs.writeFile(packageFile, original);
  const result = await installShared(f);
  const yaml = await fs.readFile(path.join(f.profile, 'cordis.patch.yml'), 'utf8');
  assert.ok(yaml.includes('userValue: !env SYNTHETIC_CUSTOM_VALUE'));
  assert.ok(yaml.includes('nested: !custom { keep: true }'));
  assert.ok(yaml.includes('customSkillDirs: !append'));
  assert.ok(yaml.includes('- !env SYNTHETIC_SKILL_DIR'));
  assert.ok(yaml.includes('root: !append'));
  assert.ok(yaml.includes('- !env SYNTHETIC_HMR_DIR'));
  assert.equal(await fs.readFile(result.backups.find(backup => backup.startsWith(packageFile)), 'utf8'), original);
  const repeated = await installShared(f);
  assert.deepEqual(repeated.changedFiles, []);
});

test('skill installer dry-run creates no destination; installed wrapper handles Unicode and spaces', async t => {
  const f = await fixture(t);
  const skillsDir = path.join(f.root, 'installed skills 技能');
  const before = await snapshot(f.root);
  const dry = await installSkills({ ...f, skillsDir, dryRun: true });
  assert.equal(dry.skills.filter(skill => skill.action === 'install').length, 2);
  assert.deepEqual(await snapshot(f.root), before);
  await installSkills({ ...f, skillsDir });
  const content = await fs.readFile(path.join(skillsDir, 'codex-dsh-shared', 'SKILL.md'), 'utf8');
  assert.ok(content.includes(await fs.realpath(f.project)));
  assert.ok(!content.includes('{{BRIDGE_REPO}}'));
  const wrapper = path.join(skillsDir, 'dsh-orchestrator', 'scripts', 'bridge.mjs');
  assert.equal(execFileSync(process.execPath, [wrapper], { encoding: 'utf8' }).trim(), 'portable cli ok');
  const applied = await snapshot(f.root);
  const repeat = await installSkills({ ...f, skillsDir });
  assert.ok(repeat.skills.every(skill => skill.action === 'unchanged'));
  assert.deepEqual(await snapshot(f.root), applied);
});

test('skill modifications require explicit update and complete directory backups', async t => {
  const f = await fixture(t);
  const skillsDir = path.join(f.root, 'skills');
  await installSkills({ ...f, skillsDir });
  const target = path.join(skillsDir, 'dsh-orchestrator');
  await fs.appendFile(path.join(target, 'SKILL.md'), 'User changes that must survive.\n');
  await fs.writeFile(path.join(target, 'user-notes.txt'), 'user notes');
  const before = await snapshot(f.root);
  await assert.rejects(installSkills({ ...f, skillsDir }), /Use --update/);
  assert.deepEqual(await snapshot(f.root), before);
  const dry = await installSkills({ ...f, skillsDir, update: true, dryRun: true });
  assert.equal(dry.skills.find(skill => skill.name === 'dsh-orchestrator').action, 'update');
  assert.deepEqual(await snapshot(f.root), before);
  const result = await installSkills({ ...f, skillsDir, update: true });
  assert.equal(result.backups.length, 1);
  assert.equal(await fs.readFile(path.join(result.backups[0], 'user-notes.txt'), 'utf8'), 'user notes');
  assert.ok((await fs.readFile(path.join(result.backups[0], 'SKILL.md'), 'utf8')).includes('User changes'));
  await assert.rejects(fs.access(path.join(target, 'user-notes.txt')), { code: 'ENOENT' });
});

test('Windows npm codex.cmd resolves to Node without shell expansion; native exe and PATH work', async t => {
  const f = await fixture(t);
  const binDir = path.join(f.root, 'npm 中文 & space');
  await fs.mkdir(path.join(binDir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  const shim = path.join(binDir, 'codex.cmd');
  const script = path.join(binDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await fs.writeFile(shim, '@echo off\n');
  await fs.writeFile(script, 'console.log("shim entry works");\n');
  const explicit = codexInvocation(shim, { platform: 'win32' });
  assert.equal(explicit.command, process.execPath);
  assert.deepEqual(explicit.prefix, [script]);
  assert.equal(execFileSync(explicit.command, explicit.prefix, { encoding: 'utf8' }).trim(), 'shim entry works');
  assert.deepEqual(codexInvocation('codex', { platform: 'win32', env: { PATH: binDir } }), explicit);
  const native = path.join(binDir, 'codex.exe');
  await fs.writeFile(native, 'fixture');
  assert.deepEqual(codexInvocation('codex', { platform: 'win32', env: { PATH: binDir } }), { command: native, prefix: [] });
  await assert.rejects(async () => codexInvocation(path.join(f.root, 'unmanaged.cmd'), { platform: 'win32' }), /Cannot locate the JavaScript/);
});

test('CLI help and malformed arguments are safe; --profile selects an isolated directory', async t => {
  const f = await fixture(t);
  assert.throws(() => parseOptions(['--profile'], { value: ['--profile'] }), /requires a value/);
  assert.throws(() => parseOptions(['--unknown'], {}), /Unknown option/);
  for (const script of ['install-shared.mjs', 'install-skills.mjs', 'verify-shared.mjs', 'smoke-v2.mjs', 'guard-check.mjs', 'mcp-e2e.mjs']) {
    const result = spawnSync(process.execPath, [path.join(repo, 'scripts', script), '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
  const before = await snapshot(f.root);
  const selected = spawnSync(process.execPath, [path.join(repo, 'scripts', 'install-shared.mjs'), '--profile', f.profile, '--dry-run'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: f.codexHome } });
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(JSON.parse(selected.stdout).profile, f.profile);
  assert.ok(!selected.stdout.includes('synthetic-secret-do-not-print'));
  assert.deepEqual(await snapshot(f.root), before);
});

test('live verifier checks metadata only, requires no LMS/history/notes, and accepts optional advertised MCP', async t => {
  const f = await fixture(t);
  const calls = [];
  const runtime = { version: 1, tools: ['codex_shared_memory', 'codex_shared_memory_put', 'codex_request', 'codex_request_wait'], skills: true, sessions: true, portableMcp: { lms: 0, example: 3 } };
  const execute = async (args, options) => {
    calls.push(args[0]);
    assert.equal(options.root, f.root);
    const data = args[0] === 'health' ? { alive: true, version: 2 }
      : args[0] === 'shared-status' ? runtime
        : args[0] === 'shared-skills' ? { skills: [{ name: 'codex-dsh-shared' }, { name: 'dsh-orchestrator' }] }
          : args[0] === 'shared-skill' ? { name: args[1] } : assert.fail(`Unexpected write or history command: ${args[0]}`);
    return { exitCode: 0, stdout: JSON.stringify(data) };
  };
  const before = await snapshot(f.root);
  const result = await verifyShared({ root: f.root, execute, requireMcp: ['example'] });
  assert.equal(result.verified, true);
  assert.equal(result.portableMcp.lms, 0);
  assert.deepEqual(calls, ['health', 'shared-status', 'shared-skills', 'shared-skill', 'shared-skill']);
  assert.deepEqual(await snapshot(f.root), before);
  await assert.rejects(verifyShared({ root: f.root, execute, requireMcp: ['lms'] }), /no advertised tools/);
  const absent = path.join(f.root, 'does not exist');
  await assert.rejects(verifyShared({ root: absent, execute }), /does not exist/);
  await assert.rejects(fs.access(absent), { code: 'ENOENT' });
});
