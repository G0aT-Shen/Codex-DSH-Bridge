#!/usr/bin/env node
// Install relocatable bundled skills; never overwrite a different tree implicitly.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backupSuffix, isMain, parseOptions, resolvePath, runCli } from './deployment-options.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillNames = ['codex-dsh-shared', 'dsh-orchestrator'];
const help = `Usage: node scripts/install-skills.mjs [options]
  --skills-dir PATH    Destination (default: $CODEX_HOME/skills or ~/.codex/skills)
  --update             Replace different existing skill trees after backing them up
  --dry-run            Inspect the plan without writing directories, files or backups
  --help               Show this help

Installs codex-dsh-shared and dsh-orchestrator with this checkout's absolute CLI path.
Identical skill trees are left untouched. Different trees require --update.
Updates preserve each entire previous directory as a sibling .codex-bridge-backup-*.
Targets that are symlinks are refused. Keep this checkout at the installed path.`;

async function fileTree(directory) {
  const files = new Map();
  async function walk(relative = '') {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.set(name, await fs.readFile(path.join(directory, name)));
      else throw new Error('Skill trees must contain only ordinary files and directories; symlinks are refused.');
    }
  }
  await walk();
  return files;
}

function treeHash(files) {
  const hash = createHash('sha256');
  for (const [name, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) hash.update(name).update('\0').update(String(content.length)).update('\0').update(content);
  return hash.digest('hex');
}

async function existingTree(target) {
  const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('A skill destination is a symlink or a non-directory. Choose --skills-dir or remove that target explicitly.');
  return fileTree(target);
}

export async function installSkills(options = {}) {
  const project = await fs.realpath(options.project ?? projectRoot);
  const userHome = options.userHome ?? os.homedir();
  const codexHome = resolvePath(options.codexHome ?? process.env.CODEX_HOME ?? path.join(userHome, '.codex'), userHome);
  const skillsDir = resolvePath(options.skillsDir ?? path.join(codexHome, 'skills'), userHome);
  const dryRun = options.dryRun === true;
  const jobs = [];
  for (const name of skillNames) {
    const source = path.join(project, 'skills', name);
    const sourceFiles = await fileTree(source);
    if (!sourceFiles.has('SKILL.md')) throw new Error(`Bundled skill is missing SKILL.md: ${name}.`);
    const files = new Map([...sourceFiles].map(([relative, content]) => [relative, Buffer.from(content.toString('utf8').replaceAll('{{BRIDGE_REPO}}', project))]));
    if (name === 'dsh-orchestrator') {
      files.set(path.join('scripts', 'bridge.mjs'), Buffer.from(`import { main } from ${JSON.stringify(pathToFileURL(path.join(project, 'cli.mjs')).href)};\nPromise.resolve().then(() => main()).catch(error => { console.error(error.message); process.exitCode = 1; });\n`));
    }
    const target = path.join(skillsDir, name);
    const previous = await existingTree(target);
    const previousHash = previous ? treeHash(previous) : null;
    const same = previousHash === treeHash(files);
    if (previous && !same && !options.update) throw new Error(`Existing skill differs: ${name}. Use --update to replace it with a complete backup, or choose --skills-dir.`);
    jobs.push({ name, target, files, previousHash, action: same ? 'unchanged' : previous ? 'update' : 'install' });
  }
  const summary = { dryRun, project, skillsDir, skills: jobs.map(({ name, target, action }) => ({ name, target, action })), backups: [] };
  const changed = jobs.filter(job => job.action !== 'unchanged');
  if (dryRun || !changed.length) return summary;
  await fs.mkdir(skillsDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(skillsDir, '.codex-bridge-install-'));
  const completed = [];
  try {
    // Prepare every replacement before changing any user skill tree.
    for (const job of changed) {
      job.staged = path.join(staging, job.name);
      for (const [relative, content] of job.files) {
        const destination = path.join(job.staged, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content, { mode: 0o644, flag: 'wx' });
      }
    }
    for (const job of changed) {
      const latest = await existingTree(job.target);
      if ((latest ? treeHash(latest) : null) !== job.previousHash) throw new Error('A skill changed during installation. Retry without concurrent edits.');
      if (latest) {
        job.backup = job.target + backupSuffix();
        await fs.rename(job.target, job.backup);
        summary.backups.push(job.backup);
      }
      try { await fs.rename(job.staged, job.target); }
      catch (error) { if (job.backup) await fs.rename(job.backup, job.target); throw error; }
      completed.push(job);
    }
  } catch (error) {
    for (const job of completed.reverse()) {
      await fs.rm(job.target, { recursive: true });
      if (job.backup) await fs.rename(job.backup, job.target);
    }
    throw error;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseOptions(argv, { boolean: ['--update', '--dry-run', '--help'], value: ['--skills-dir'] });
  if (flags['--help']) { console.log(help); return; }
  console.log(JSON.stringify(await installSkills({ skillsDir: flags['--skills-dir'], update: flags['--update'], dryRun: flags['--dry-run'] }), null, 2));
}
if (isMain(import.meta.url)) await runCli(main);
