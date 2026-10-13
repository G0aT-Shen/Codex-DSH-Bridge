// Shared, explicit local state. No model-internal reasoning or credential stores.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ROOT, atomicJson, readJson, validId, isWindowsDeviceName, jobDir } from './protocol.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const privateKey = /^(?:authorization|cookie|set-cookie|password|passwd|secret|client_secret|clientSecret|api_key|apiKey|access_token|accessToken|refresh_token|refreshToken|token)$/i;
export function publicText(text) {
  return String(text ?? '').replace(/<(think|reasoning)>[\s\S]*?<\/\1>/gi, '[internal reasoning omitted]')
    .replace(/<(think|reasoning)>[\s\S]*$/gi, '[internal reasoning omitted]')
    .replace(/Bearer\s+[\w.+\/-]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|client[_-]?secret|authorization|cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]');
}
export function publicValue(value) {
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(publicValue(parsed)); } catch { /* ordinary text */ }
    return publicText(value);
  }
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, privateKey.test(key) ? '[redacted]' : publicValue(v)]));
  return value;
}
export function publicEvent(event, maxChars = 6000) {
  if (!event || !['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message', 'approval/asked', 'approval/decided'].includes(event.type)) return null;
  const data = event.data ?? {};
  const row = { seq: event.seq, time: event.time ?? null, type: event.type, turn: data.turn ?? null, step: data.step ?? null };
  if (event.type === 'tool/call') Object.assign(row, { callId: data.callId, name: data.name, arguments: publicValue(data.arguments) });
  if (event.type === 'assistant/message' || event.type === 'tool/result') {
    const message = data.message ?? {};
    row.text = publicText((message.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n')).slice(0, maxChars);
    row.omittedNonTextBlocks = (message.content ?? []).filter(x => x.type !== 'text').length;
    if (event.type === 'tool/result') Object.assign(row, { callId: message.callId ?? data.callId ?? message.toolCallId, isError: Boolean(message.isError) });
  }
  if (event.type === 'turn/end') row.reason = publicValue(data.reason);
  if (event.type.startsWith('approval/')) Object.assign(row, { tool: data.toolName ?? null, outcome: data.outcome ?? null });
  return row;
}

export async function readJobEvents(root, id, { cursor = 0, limit = 40 } = {}) {
  if (!validId(id)) throw new Error('Invalid job id');
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid byte cursor');
  const size = Math.max(1, Math.min(100, Number(limit) || 40));
  const file = await fs.open(path.join(jobDir(root, id), 'events.jsonl'), 'r');
  try {
    const total = (await file.stat()).size;
    if (cursor > total) throw new Error('Event file changed; restart with cursor=0');
    const bytes = Buffer.alloc(Math.min(total - cursor, 1024 * 1024));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, cursor);
    const rows = []; let start = 0, nextCursor = cursor;
    for (let end = 0; end < bytesRead; end++) {
      if (bytes[end] !== 10) continue;
      const raw = bytes.subarray(start, end).toString('utf8');
      start = end + 1; nextCursor = cursor + start;
      try { const row = publicEvent(JSON.parse(raw)); if (row) rows.push(row); } catch { /* corrupt complete line is skipped */ }
      if (rows.length >= size) break;
    }
    if (bytesRead === 1024 * 1024 && nextCursor === cursor) throw new Error('Event line exceeds 1 MiB; use a bounded session view');
    return { id, events: rows, nextCursor, hasMore: nextCursor < total, bytes: total, scope: 'public messages and tool activity; internal reasoning excluded' };
  } finally { await file.close(); }
}

const sharedPath = (root, ...parts) => path.join(root, 'shared', ...parts);
const memoryKey = key => { if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(key) || isWindowsDeviceName(key)) throw new Error('Invalid memory key'); return key; };
export async function readSharedMemory(root = DEFAULT_ROOT, key) {
  const dir = sharedPath(root, 'memory');
  if (key) return readJson(path.join(dir, memoryKey(key) + '.json'), { key, revision: 0, text: '' });
  const files = (await fs.readdir(dir).catch(() => [])).filter(x => /^[a-z0-9][a-z0-9._-]{0,79}\.json$/.test(x)).sort();
  const entries = await Promise.all(files.map(file => readJson(path.join(dir, file))));
  return { entries, source: 'explicit shared notes, not internal model memory' };
}
export async function putSharedMemory(root, { key, text, expectedRevision, author = 'user-authorized agent' }) {
  memoryKey(key);
  if (typeof text !== 'string' || text.length > 16000) throw new Error('Memory text must be a string up to 16000 characters');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Read memory first and provide expectedRevision');
  const dir = sharedPath(root, 'memory'); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(dir, key + '.lock');
  const lock = await fs.open(lockFile, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw new Error('Memory update busy; retry after reading latest revision'); throw error; });
  try {
    const previous = await readSharedMemory(root, key);
    if (previous.revision !== expectedRevision) throw new Error(`Memory conflict: expected ${expectedRevision}, found ${previous.revision}`);
    const record = { key, text: publicText(text), revision: previous.revision + 1, updatedAt: new Date().toISOString(), author: publicText(author) };
    await atomicJson(path.join(dir, key + '.json'), record); return record;
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
export async function readPublishedCodexMemory(codexHome) {
  const file = path.join(codexHome, 'memories', 'memory_summary.md');
  try {
    const stat = await fs.stat(file);
    if (stat.size > 128 * 1024) throw new Error('Published memory summary exceeds 128 KiB');
    return { available: true, path: file, text: publicText(await fs.readFile(file, 'utf8')), note: 'Published summary only; not a raw conversation or internal reasoning export' };
  } catch (error) { if (error.code === 'ENOENT') return { available: false, note: 'No published Codex memory summary exists; explicit shared notes are available separately' }; throw error; }
}

export async function submitCodexRequest(root, args, source = {}) {
  if (!['skill', 'plugin'].includes(args.capability)) throw new Error('capability must be skill or plugin');
  if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200) throw new Error('Provide a capability name');
  if (typeof args.instruction !== 'string' || !args.instruction.trim() || args.instruction.length > 16000) throw new Error('Provide an instruction up to 16000 characters');
  const id = randomUUID(); const dir = sharedPath(root, 'requests', id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const timeout = Math.min(1800, Math.max(30, Number(args.timeoutSeconds) || 600));
  const request = { id, state: 'pending', capability: args.capability, name: args.name, instruction: publicText(args.instruction), sessionId: source.sessionId ?? null, jobId: source.jobId ?? null,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + timeout * 1000).toISOString() };
  await atomicJson(path.join(dir, 'request.json'), request); return request;
}
export async function getCodexRequest(root, id) {
  if (!validId(id)) throw new Error('Invalid request id');
  const dir = sharedPath(root, 'requests', id);
  const request = await readJson(path.join(dir, 'request.json'));
  const response = await readJson(path.join(dir, 'response.json'), null);
  return response ? { ...request, state: response.isError ? 'failed' : 'completed', response } : { ...request, state: Date.now() > Date.parse(request.expiresAt) ? 'expired' : 'pending' };
}
export async function listCodexRequests(root, { jobId, pendingOnly = true } = {}) {
  const dir = sharedPath(root, 'requests');
  const files = (await fs.readdir(dir).catch(() => [])).filter(validId).sort();
  const all = await Promise.all(files.map(id => getCodexRequest(root, id)));
  return all.filter(x => (!jobId || x.jobId === jobId) && (!pendingOnly || x.state === 'pending')).slice(0, 40);
}
export async function respondCodexRequest(root, { id, text, isError = false }) {
  const request = await getCodexRequest(root, id);
  if (request.state !== 'pending') throw new Error(`Request is ${request.state}; cannot respond twice or after expiry`);
  if (typeof text !== 'string' || text.length > 64000) throw new Error('Response must be a string up to 64000 characters');
  const response = { text: publicText(text), isError: Boolean(isError), completedAt: new Date().toISOString() };
  const dir = sharedPath(root, 'requests', id);
  const temp = path.join(dir, `${randomUUID()}.response.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(response) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.link(temp, path.join(dir, 'response.json'));
  } finally { await fs.unlink(temp).catch(() => {}); }
  return { id, state: isError ? 'failed' : 'completed' };
}
export async function waitCodexRequest(root, id, { timeoutSeconds = 45, signal } = {}) {
  const end = Date.now() + Math.max(0, Math.min(50, Number(timeoutSeconds) || 0)) * 1000;
  for (;;) {
    signal?.throwIfAborted(); const request = await getCodexRequest(root, id);
    if (request.state !== 'pending' || Date.now() >= end) return request;
    await delay(200);
  }
}

export async function callSharedHost(root, command, args = {}) {
  const endpoint = await readJson(sharedPath(root, 'host.json'), null);
  if (!endpoint?.url || !endpoint.alive) throw new Error('DSH shared-capability plugin is not online');
  const url = new URL(endpoint.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/codex-shared') throw new Error('Invalid local shared-service endpoint');
  const token = (await fs.readFile(path.join(root, 'token'), 'utf8')).trim();
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, args }), signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `DSH shared-service HTTP ${response.status}`);
  return body;
}
