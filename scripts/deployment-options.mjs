import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function parseOptions(argv, { boolean = [], value = [], repeat = [] }) {
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (boolean.includes(option)) {
      if (flags[option]) throw new Error(`Option ${option} may only be provided once.`);
      flags[option] = true;
    } else if (value.includes(option) || repeat.includes(option)) {
      const argument = argv[++index];
      if (!argument || argument.startsWith('--')) throw new Error(`Option ${option} requires a value.`);
      if (repeat.includes(option)) (flags[option] ??= []).push(argument);
      else {
        if (flags[option] !== undefined) throw new Error(`Option ${option} may only be provided once.`);
        flags[option] = argument;
      }
    } else throw new Error('Unknown option. Use --help to see supported options.');
  }
  return flags;
}

export function resolvePath(value, userHome = os.homedir()) {
  if (value === '~') return userHome;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.resolve(userHome, value.slice(2));
  return path.resolve(value);
}

export function backupSuffix() {
  return `.codex-bridge-backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
}

// npm's Windows .cmd shim is not directly executable by execFile. Run its known JS
// entry point through Node, without introducing cmd.exe expansion or shell quoting.
export function codexInvocation(binary = 'codex', { platform = process.platform, env = process.env } = {}) {
  let executable = binary;
  if (!path.isAbsolute(binary) && !binary.includes('/') && !binary.includes('\\')) {
    const directories = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : path.delimiter);
    const suffixes = platform === 'win32' && !path.extname(binary) ? ['.exe', '.cmd', ''] : [''];
    executable = directories.flatMap(directory => suffixes.map(suffix => path.join(directory, binary + suffix))).find(candidate => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
    if (!executable) throw new Error('Codex executable was not found on PATH. Supply --codex-bin.');
  }
  executable = path.resolve(executable);
  if (platform === 'win32' && /\.cmd$/i.test(executable)) {
    const directory = path.dirname(executable);
    const candidates = [path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), path.join(directory, '..', '@openai', 'codex', 'bin', 'codex.js')];
    const script = candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
    if (!script) throw new Error('Cannot locate the JavaScript entry point for this codex.cmd. Use a standard npm Codex installation or supply a native codex.exe.');
    return { command: process.execPath, prefix: [script] };
  }
  if (platform === 'win32' && /\.(bat|ps1)$/i.test(executable)) throw new Error('Use a native codex.exe or the standard npm codex.cmd with --codex-bin.');
  return { command: executable, prefix: [] };
}

export function isMain(url) { return Boolean(process.argv[1]) && url === pathToFileURL(path.resolve(process.argv[1])).href; }

export async function runCli(main) {
  if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Node.js 22 or newer is required.'); process.exitCode = 1; return; }
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
