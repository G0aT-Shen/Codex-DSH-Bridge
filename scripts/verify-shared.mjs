#!/usr/bin/env node
// Read-only live checks. No installer, profile edits, model tasks or historical state.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execute } from '../cli.mjs';
import { DEFAULT_ROOT } from '../protocol.js';
import { isMain, parseOptions, resolvePath, runCli } from './deployment-options.mjs';

const requiredTools = ['codex_shared_memory', 'codex_shared_memory_put', 'codex_request', 'codex_request_wait'];
const help = `Usage: node scripts/verify-shared.mjs [options]
  --root PATH          Existing bridge queue directory (default: standard bridge queue)
  --skill NAME         Shared skill to verify; repeat (default: both bundled bridge skills)
  --require-mcp NAME   Require a positive advertised count for an optional MCP server
  --help               Show this help

The desktop DSH bridge and shared plugin must already be running.
Reads live health, tool metadata and shared skill names. Does not reconfigure profiles,
install anything, run a model, read shared notes or depend on an earlier smoke report.`;

export async function verifyShared(options = {}) {
  const root = resolvePath(options.root ?? DEFAULT_ROOT);
  const stat = await fs.stat(root).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Bridge queue directory does not exist. Start desktop DSH or select an existing queue with --root.');
    throw error;
  });
  if (!stat.isDirectory()) throw new Error('Bridge --root must be an existing directory.');
  const command = options.execute ?? execute;
  const call = async argv => {
    const result = await command([...argv, '--json'], { root });
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw new Error(`Invalid response from ${argv[0]}. Check the desktop bridge.`); }
    if (result.exitCode !== 0) throw new Error(`${argv[0]} failed. Start desktop DSH with the bridge and shared plugins enabled.`);
    return data;
  };
  const health = await call(['health']);
  if (!health.alive || health.version !== 2) throw new Error('A live bridge protocol version 2 is required. Start/reload the desktop plugins.');
  const runtime = await call(['shared-status']);
  for (const tool of requiredTools) if (!runtime.tools?.includes(tool)) throw new Error(`Shared plugin is missing ${tool}. Reload the current shared plugin.`);
  if (!runtime.skills || !runtime.sessions) throw new Error('Shared plugin is missing desktop skill or session services.');
  const skills = await call(['shared-skills']);
  if (!Array.isArray(skills.skills)) throw new Error('Shared skill discovery returned invalid metadata.');
  const requestedSkills = [...new Set(options.skills ?? ['codex-dsh-shared', 'dsh-orchestrator'])];
  const discovered = new Set(skills.skills.map(skill => skill.name));
  for (const name of requestedSkills) {
    if (!discovered.has(name)) throw new Error(`Shared skill unavailable: ${name}. Install bundled skills and check shared skill roots.`);
    const loaded = await call(['shared-skill', name]);
    if (loaded.name !== name) throw new Error(`Shared skill lookup did not load ${name}.`);
  }
  for (const name of options.requireMcp ?? []) {
    if (!Number.isSafeInteger(runtime.portableMcp?.[name]) || runtime.portableMcp[name] <= 0) throw new Error(`MCP server ${name} has no advertised tools. Check its shared stdio configuration; older shared plugins may not advertise this server.`);
  }
  return { verified: true, readOnly: true, queueDir: root, bridgeVersion: health.version, sharedVersion: runtime.version ?? null, sharedTools: requiredTools, sharedSkillCount: skills.skills.length, loadedSkills: requestedSkills, portableMcp: runtime.portableMcp ?? {}, limitations: ['Checks advertised tools and skill loading; no school API request or model execution.', 'Reverse capability requests still require an active Codex supervisor.'] };
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseOptions(argv, { boolean: ['--help'], value: ['--root'], repeat: ['--skill', '--require-mcp'] });
  if (flags['--help']) { console.log(help); return; }
  console.log(JSON.stringify(await verifyShared({ root: flags['--root'], skills: flags['--skill'], requireMcp: flags['--require-mcp'] }), null, 2));
}
if (isMain(import.meta.url)) await runCli(main);
