#!/usr/bin/env node
// Local-only deployment. No package downloads or model runs; stop DSH before applying.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { backupSuffix, codexInvocation, isMain, parseOptions, resolvePath, runCli } from './deployment-options.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `Usage: node scripts/install-shared.mjs [options]
  --profile PATH       DSH profile directory (default: ~/.dsh/profiles/desktop)
  --queue-dir PATH     Set the same queue directory on both bridge plugins
  --codex-bin PATH     Codex executable or command (default: codex; only used for MCP)
  --mcp-server NAME    Mirror an enabled stdio Codex MCP server; repeat for multiple servers
  --skill-root PATH    Add a shared skill directory; repeat for multiple roots
  --no-hmr             Skip HMR installation; leave any existing HMR configuration intact
  --dry-run            Report changes without writing files, links or backups
  --help               Show this help

Installs the main bridge, shared capabilities, shared skills and (by default) HMR.
Preinstall @deepseek-ai/dsh-skill-filesystem and @deepseek-ai/dsh-hmr in the profile.
Mirroring MCP also requires @deepseek-ai/dsh-mcp-client. No MCP server is required by default.
Existing package links to another checkout are refused. Disable/remove them explicitly first.
Changed profile files are backed up beside the originals (POSIX mode 0600;
Windows access is controlled by inherited NTFS ACLs).`;

async function discoveredSkillRoots(codexHome, userHome, extraRoots) {
  const roots = new Set([path.join(codexHome, 'skills'), path.join(codexHome, 'skills', '.system'), path.join(userHome, '.agents', 'skills'), ...extraRoots]);
  async function walk(directory, depth = 0) {
    if (depth > 9) return;
    const children = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (children.some(entry => entry.name === 'SKILL.md' && entry.isFile())) { roots.add(path.dirname(directory)); return; }
    for (const entry of children) if (entry.isDirectory() && entry.name !== 'node_modules') await walk(path.join(directory, entry.name), depth + 1);
  }
  await walk(path.join(codexHome, 'plugins', 'cache'));
  return [...roots].sort();
}

function readCodexMcp(codexBin) {
  try {
    const invocation = codexInvocation(codexBin);
    const output = execFileSync(invocation.command, [...invocation.prefix, 'mcp', 'list', '--json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const servers = JSON.parse(output);
    if (!Array.isArray(servers)) throw new Error('Invalid list');
    return servers;
  } catch (error) {
    // Do not include command stdout/stderr: it may contain MCP environment values.
    if (!('stdout' in error) && /Codex executable|codex.cmd|codex.exe/.test(error.message)) throw error;
    throw new Error('Cannot list Codex MCP servers. Check --codex-bin and run `codex mcp list --json` locally.');
  }
}

function profileLocations(patches) {
  const locations = [];
  for (let index = 0; index < patches.length; index++) {
    const patch = patches[index];
    if (!patch || typeof patch !== 'object') continue;
    if (Array.isArray(patch.insert)) patch.insert.forEach((entry, item) => { if (entry && typeof entry === 'object') locations.push({ entry, keys: [index, 'insert', item] }); });
    else locations.push({ entry: patch, keys: [index] });
  }
  return locations;
}

export async function installShared(options = {}) {
  const userHome = options.userHome ?? os.homedir();
  const project = await fs.realpath(options.project ?? projectRoot);
  const profile = resolvePath(options.profile ?? path.join(userHome, '.dsh', 'profiles', 'desktop'), userHome);
  const codexHome = resolvePath(options.codexHome ?? process.env.CODEX_HOME ?? path.join(userHome, '.codex'), userHome);
  const dryRun = options.dryRun === true;
  const mcpNames = [...new Set(options.mcpServers ?? [])];
  for (const name of mcpNames) if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error('MCP server names must contain only letters, digits, underscores or hyphens.');
  const packageFile = path.join(profile, 'package.json');
  const patchFile = path.join(profile, 'cordis.patch.yml');
  const [originalPackage, originalPatch] = await Promise.all([packageFile, patchFile].map(file => fs.readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error(`DSH profile is incomplete: missing ${path.basename(file)}. Select its directory with --profile.`);
    throw error;
  })));
  let packageConfig;
  try { packageConfig = JSON.parse(originalPackage.replace(/^\uFEFF/, '')); } catch { throw new Error('Invalid profile package.json; repair it before installation.'); }
  if (!packageConfig || typeof packageConfig !== 'object' || Array.isArray(packageConfig)) throw new Error('Profile package.json must be an object.');
  if (packageConfig.dependencies != null && (typeof packageConfig.dependencies !== 'object' || Array.isArray(packageConfig.dependencies))) throw new Error('Profile package.json dependencies must be an object.');
  const patchDocument = YAML.parseDocument(originalPatch, { logLevel: 'silent' });
  if (patchDocument.errors.length) throw new Error('Invalid profile patch YAML; repair cordis.patch.yml before installation.');
  const patches = patchDocument.toJS() ?? [];
  if (!Array.isArray(patches)) throw new Error('Profile patch must be a YAML sequence.');
  const locations = profileLocations(patches);
  const roots = await discoveredSkillRoots(codexHome, userHome, (options.skillRoots ?? []).map(value => resolvePath(value, userHome)));
  const queueDir = options.queueDir ? resolvePath(options.queueDir, userHome) : null;
  const currentBridge = locations.filter(item => item.entry.id === 'codex-task-bridge');
  const currentShared = locations.filter(item => item.entry.id === 'codex-shared');
  const existingQueues = [...currentBridge, ...currentShared].map(item => item.entry.config?.queueDir).filter(value => typeof value === 'string' && value);
  if (!queueDir && new Set(existingQueues).size > 1) throw new Error('Bridge plugins use different queueDir values. Supply --queue-dir to select one explicitly.');
  const sharedQueue = queueDir ?? existingQueues[0];
  const sharedConfig = { ...(sharedQueue ? { queueDir: sharedQueue } : {}) };
  const entries = [
    { id: 'codex-task-bridge', name: '@hanyangshen/codex-bridge', config: { ...sharedConfig } },
    { id: 'codex-shared', name: '@hanyangshen/codex-shared', config: { ...sharedConfig, codexHome } },
    { id: 'codex-shared-skills', name: '@deepseek-ai/dsh-skill-filesystem', config: { providerName: 'codex-shared', includeDefaultRoots: false, customSkillDirs: roots, watch: true } },
  ];
  const servers = mcpNames.length ? (options.listMcpServers ?? readCodexMcp)(options.codexBin ?? 'codex') : [];
  for (const name of mcpNames) {
    const server = servers.find(item => item.name === name && item.enabled !== false && item.transport?.type === 'stdio');
    if (!server || typeof server.transport.command !== 'string' || !server.transport.command) throw new Error(`Codex MCP server ${name} is unavailable, disabled or not stdio.`);
    const transport = server.transport;
    entries.push({ id: `codex-shared-mcp-${name}`, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: `codex_${name}`, transport: 'stdio', command: transport.command, args: transport.args ?? [], env: transport.env ?? {}, ...(transport.cwd ? { cwd: transport.cwd } : {}) } });
  }
  if (options.hmr !== false) {
    const currentHmr = locations.find(item => item.entry.id === 'hmr');
    const previousRoots = currentHmr?.entry.config?.root ?? [];
    if (!Array.isArray(previousRoots)) throw new Error('Existing HMR root must be an array. Use --no-hmr to leave HMR untouched.');
    entries.push({ id: 'hmr', name: '@deepseek-ai/dsh-hmr', config: { root: [...new Set([...previousRoots, project])] } });
  }
  const profileRequire = createRequire(packageFile);
  const requiredPackages = [...new Set(entries.map(entry => entry.name).filter(name => name.startsWith('@deepseek-ai/')))];
  const missingPackages = requiredPackages.filter(name => { try { profileRequire.resolve(name); return false; } catch { return true; } });
  if (missingPackages.length && !dryRun) throw new Error(`Install these plugins in the selected DSH profile first: ${missingPackages.join(', ')}. This installer does not download packages.`);

  const additions = [];
  const updated = [];
  for (const entry of entries) {
    const matches = locations.filter(item => item.entry.id === entry.id);
    if (matches.length > 1) throw new Error(`Duplicate managed plugin id in profile: ${entry.id}. Reconcile it before installation.`);
    const found = matches[0];
    if (found?.entry.name && found.entry.name !== entry.name) throw new Error(`Existing profile entry conflicts with plugin ${entry.id}.`);
    if (!found) { additions.push(entry); continue; }
    if (found.entry.config != null && (typeof found.entry.config !== 'object' || Array.isArray(found.entry.config))) throw new Error(`Existing plugin config must be an object: ${entry.id}.`);
    const next = { ...found.entry.config, ...entry.config };
    if (entry.id === 'codex-shared-skills') {
      const previousRoots = found.entry.config?.customSkillDirs ?? [];
      if (!Array.isArray(previousRoots)) throw new Error('Existing customSkillDirs must be an array.');
      next.customSkillDirs = [...new Set([...previousRoots, ...roots])];
    }
    if (!isDeepStrictEqual(next, found.entry.config)) {
      if (found.entry.config == null) patchDocument.setIn([...found.keys, 'config'], {});
      // Update only managed fields. Replacing the entire config mapping would erase
      // !env/!append tags and comments from unrelated user settings.
      for (const key of Object.keys(entry.config)) {
        const previous = found.entry.config?.[key];
        if (isDeepStrictEqual(previous, next[key])) continue;
        const keys = [...found.keys, 'config', key];
        if ((key === 'customSkillDirs' || (entry.id === 'hmr' && key === 'root')) && Array.isArray(previous)) {
          for (const value of next[key]) if (!previous.includes(value)) patchDocument.addIn(keys, value);
        } else patchDocument.setIn(keys, next[key]);
      }
      updated.push(entry.id);
    }
    if (!found.entry.name) { patchDocument.setIn([...found.keys, 'name'], entry.name); updated.push(`${entry.id}:name`); }
    if (found.entry.disabled === true) { patchDocument.setIn([...found.keys, 'disabled'], false); updated.push(`${entry.id}:enable`); }
  }
  if (additions.length) patchDocument.add({ insert: additions });

  const links = [
    { packageName: '@hanyangshen/codex-bridge', source: project },
    { packageName: '@hanyangshen/codex-shared', source: path.join(project, 'shared-plugin') },
  ];
  for (const link of links) {
    link.target = path.join(profile, 'node_modules', ...link.packageName.split('/'));
    const existing = await fs.lstat(link.target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) {
      const resolved = await fs.realpath(link.target).catch(() => null);
      if (resolved !== await fs.realpath(link.source)) throw new Error(`Existing ${link.packageName} package points elsewhere. Disable/remove it explicitly before installing this checkout.`);
    }
    link.create = !existing;
  }
  packageConfig.dependencies ??= {};
  for (const link of links) packageConfig.dependencies[link.packageName] = `link:${link.source}`;
  const packageChanged = !isDeepStrictEqual(JSON.parse(originalPackage.replace(/^\uFEFF/, '')), packageConfig);
  const changes = [];
  if (packageChanged) changes.push({ file: packageFile, content: JSON.stringify(packageConfig, null, 2) + '\n', original: originalPackage });
  if (additions.length || updated.length) changes.push({ file: patchFile, content: patchDocument.toString(), original: originalPatch });
  const summary = { dryRun, profile, installed: additions.map(entry => entry.id), updated, linksToCreate: links.filter(link => link.create).map(link => link.target), changedFiles: changes.map(change => change.file), sharedSkillRoots: roots, portableMcp: mcpNames, hmr: options.hmr !== false, missingPackages, backups: [] };
  if (dryRun) return summary;
  const suffix = backupSuffix();
  const createdLinks = [];
  const writtenFiles = [];
  try {
    for (const change of changes) {
      if (await fs.readFile(change.file, 'utf8') !== change.original) throw new Error('Profile changed during installation. Retry with DSH stopped.');
      const backup = change.file + suffix;
      await fs.copyFile(change.file, backup, fs.constants.COPYFILE_EXCL);
      await fs.chmod(backup, 0o600);
      summary.backups.push(backup);
    }
    for (const link of links.filter(item => item.create)) {
      await fs.mkdir(path.dirname(link.target), { recursive: true });
      await fs.symlink(link.source, link.target, process.platform === 'win32' ? 'junction' : 'dir');
      createdLinks.push(link.target);
    }
    for (const change of changes) {
      const temporary = change.file + suffix + '.tmp';
      try {
        await fs.writeFile(temporary, change.content, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, change.file);
        writtenFiles.push(change);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    }
  } catch (error) {
    for (const change of writtenFiles.reverse()) await fs.writeFile(change.file, change.original, { mode: 0o600 });
    for (const target of createdLinks.reverse()) await fs.unlink(target).catch(() => {});
    throw error;
  }
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseOptions(argv, { boolean: ['--dry-run', '--no-hmr', '--help'], value: ['--profile', '--queue-dir', '--codex-bin'], repeat: ['--mcp-server', '--skill-root'] });
  if (flags['--help']) { console.log(help); return; }
  const result = await installShared({ profile: flags['--profile'], queueDir: flags['--queue-dir'], codexBin: flags['--codex-bin'], mcpServers: flags['--mcp-server'], skillRoots: flags['--skill-root'], dryRun: flags['--dry-run'], hmr: !flags['--no-hmr'] });
  console.log(JSON.stringify(result, null, 2));
  if (result.missingPackages.length) process.exitCode = 2;
}
if (isMain(import.meta.url)) await runCli(main);
