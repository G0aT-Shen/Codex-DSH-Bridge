import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  publicText, publicValue, publicEvent, readJobEvents,
  readSharedMemory, putSharedMemory, readPublishedCodexMemory,
  submitCodexRequest, getCodexRequest, listCodexRequests,
  respondCodexRequest, waitCodexRequest,
} from '../shared.mjs';
import { tempRoot } from './helpers.mjs';
import { execute } from '../cli.mjs';

const event = (seq, text, overrides = {}) => ({
  seq, time: 1000 + seq, type: 'assistant/message',
  data: { turn: 1, step: seq, message: { content: [{ type: 'text', text }] } },
  ...overrides,
});

test('shared note keys exclude Windows device names and extension variants', async t => {
  const root = await tempRoot(t);
  for (const key of ['con', 'nul.note', 'aux', 'prn', 'com1', 'lpt9.txt']) {
    await assert.rejects(putSharedMemory(root, { key, text: 'x', expectedRevision: 0 }), /Invalid memory key/);
  }
});

test('JSON files handle UTF-8 BOM and avoid shell-dependent inline quoting', async t => {
  const { root, request } = await requestFixture(t);
  const response = path.join(root, '回包 response.json');
  await fs.writeFile(response, '\uFEFF' + JSON.stringify({ text: '中文 "quoted" $literal', isError: false }));
  const result = await execute(['respond', request.id, '--file', response], { root });
  assert.equal(result.exitCode, 0);
  assert.equal((await getCodexRequest(root, request.id)).response.text, '中文 "quoted" $literal');
  await assert.rejects(execute(['memory-put', '--inline', '{}', '--file', response], { root }), /either --inline or --file/);
  const note = path.join(root, '笔记.json');
  await fs.writeFile(note, '\uFEFF' + JSON.stringify({ key: 'test-note', text: 'safe', expectedRevision: 0 }));
  assert.equal((await execute(['memory-put', '--file', note], { root })).exitCode, 0);
  assert.equal((await readSharedMemory(root, 'test-note')).text, 'safe');
});
const jsonLine = value => Buffer.from(JSON.stringify(value) + '\n');
async function eventFile(t, initial) {
  const root = await tempRoot(t, 'dsh-shared-test-');
  const dir = path.join(root, 'jobs', 'job-one');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, initial);
  return { root, file };
}
async function requestFixture(t, source = {}) {
  const root = await tempRoot(t, 'dsh-shared-request-');
  const request = await submitCodexRequest(root, {
    capability: 'skill', name: 'canvas-desktop', instruction: '查本周 DDL',
  }, source);
  return { root, request };
}

test('event pagination resumes at complete byte lines and preserves Unicode', async t => {
  const rows = [event(0, '第一条 🧪'), event(1, '截止时间 23:59 🇭🇰'), event(2, '第三条 é')];
  const lines = rows.map(jsonLine);
  const { root } = await eventFile(t, Buffer.concat(lines));
  const first = await readJobEvents(root, 'job-one', { limit: 1 });
  assert.deepEqual(first.events.map(x => x.text), ['第一条 🧪']);
  assert.equal(first.nextCursor, lines[0].length);
  assert.equal(first.hasMore, true);
  const second = await readJobEvents(root, 'job-one', { cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(second.events.map(x => x.text), ['截止时间 23:59 🇭🇰']);
  assert.equal(second.nextCursor, lines[0].length + lines[1].length);
  const third = await readJobEvents(root, 'job-one', { cursor: second.nextCursor });
  assert.deepEqual(third.events.map(x => x.text), ['第三条 é']);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, Buffer.concat(lines).length);
});

test('an incomplete line split inside a Unicode character is retried without loss', async t => {
  const first = jsonLine(event(0, 'done'));
  const pending = jsonLine(event(1, '半行中文 🧪 完整后读取'));
  const emojiAt = pending.indexOf(Buffer.from('🧪'));
  const cut = emojiAt + 2;
  const { root, file } = await eventFile(t, Buffer.concat([first, pending.subarray(0, cut)]));
  const before = await readJobEvents(root, 'job-one');
  assert.deepEqual(before.events.map(x => x.seq), [0]);
  assert.equal(before.nextCursor, first.length);
  assert.equal(before.hasMore, true);
  const stillPending = await readJobEvents(root, 'job-one', { cursor: before.nextCursor });
  assert.equal(stillPending.events.length, 0);
  assert.equal(stillPending.nextCursor, first.length);
  await fs.appendFile(file, pending.subarray(cut));
  const complete = await readJobEvents(root, 'job-one', { cursor: before.nextCursor });
  assert.deepEqual(complete.events.map(x => x.text), ['半行中文 🧪 完整后读取']);
  assert.equal(complete.nextCursor, first.length + pending.length);
  assert.equal(complete.hasMore, false);
});

test('a read buffer ending mid-line leaves that event for the next page', async t => {
  const a = jsonLine(event(0, '首项 🧪', { padding: 'a'.repeat(700000) }));
  const b = jsonLine(event(1, '次项 中文 🇭🇰', { padding: 'b'.repeat(700000) }));
  const { root } = await eventFile(t, Buffer.concat([a, b]));
  const first = await readJobEvents(root, 'job-one');
  assert.deepEqual(first.events.map(x => x.seq), [0]);
  assert.equal(first.nextCursor, a.length);
  const second = await readJobEvents(root, 'job-one', { cursor: first.nextCursor });
  assert.deepEqual(second.events.map(x => x.text), ['次项 中文 🇭🇰']);
  assert.equal(second.nextCursor, a.length + b.length);
  assert.equal(second.hasMore, false);
});

test('skipped non-public and malformed lines still advance the byte cursor', async t => {
  const hidden = jsonLine({ seq: 0, type: 'request/header', data: { private: 'excluded' } });
  const corrupt = Buffer.from('{not-json}\n');
  const publicLine = jsonLine(event(2, 'visible'));
  const all = Buffer.concat([hidden, corrupt, publicLine]);
  const { root } = await eventFile(t, all);
  const result = await readJobEvents(root, 'job-one');
  assert.deepEqual(result.events.map(x => x.text), ['visible']);
  assert.equal(result.nextCursor, all.length);
  assert.equal(result.hasMore, false);
  await assert.rejects(readJobEvents(root, 'job-one', { cursor: all.length + 1 }), /changed|cursor/);
});

test('public events omit non-text thoughts and provider replay details', () => {
  const row = publicEvent(event(4, 'visible', {
    data: {
      turn: 1, step: 4,
      stream: [{ chunk: { type: 'reasoning', text: 'raw hidden stream' } }],
      message: {
        source: { replayState: 'private provider replay' },
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          { type: 'thinking', thinking: 'private thought' },
          { type: 'text', text: 'public result' },
          { type: 'tool-call', name: 'read', arguments: { secret: 'also omitted here' } },
        ],
      },
    },
  }));
  assert.equal(row.text, 'public result');
  assert.equal(row.omittedNonTextBlocks, 3);
  assert.doesNotMatch(JSON.stringify(row), /private|raw hidden|replay|also omitted/);
  assert.equal(publicEvent({ type: 'assistant/attempt', data: {} }), null);
});

test('public tools keep call identity but scrub credential fields recursively', () => {
  const row = publicEvent({
    seq: 6, time: 1234, type: 'tool/call',
    data: { turn: 1, step: 2, callId: 'call-1', name: 'read_api', arguments: {
      Authorization: 'Bearer token-value', Cookie: 'secret-session',
      nested: [{ apiKey: 'nested-key', refresh_token: 'refresh-value', keep: 'course-1' }],
    } },
  });
  assert.equal(row.callId, 'call-1');
  assert.equal(row.name, 'read_api');
  assert.equal(row.arguments.Authorization, '[redacted]');
  assert.equal(row.arguments.Cookie, '[redacted]');
  assert.deepEqual(row.arguments.nested, [{ apiKey: '[redacted]', refresh_token: '[redacted]', keep: 'course-1' }]);
  assert.doesNotMatch(JSON.stringify(row), /token-value|secret-session|nested-key|refresh-value/);
  const result = publicEvent({ seq: 7, type: 'tool/result', data: {
    turn: 1, step: 2, message: { callId: 'call-1', isError: true,
      content: [{ type: 'text', text: 'Authorization: Bearer confidential' }] },
  } });
  assert.equal(result.callId, 'call-1');
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.text, /confidential/);
});

test('credential keys and inline secrets are sanitized without changing ordinary values', () => {
  const sensitiveKeys = ['authorization', 'COOKIE', 'set-cookie', 'password', 'passwd',
    'secret', 'client_secret', 'clientSecret', 'api_key', 'apiKey',
    'access_token', 'accessToken', 'refresh_token', 'refreshToken', 'token'];
  const original = Object.fromEntries(sensitiveKeys.map(key => [key, 'sentinel-private-value']));
  original.details = { enabled: true, count: 3, note: 'course deadline' };
  const clean = publicValue(original);
  for (const key of sensitiveKeys) assert.equal(clean[key], '[redacted]');
  assert.deepEqual(clean.details, original.details);
  assert.equal(original.apiKey, 'sentinel-private-value', 'sanitizing does not mutate input');
  const text = publicText('OK <think>private thought</think> next api_key="fake-key" password=fake-pass Bearer fake-token');
  assert.match(text, /OK .* next/);
  assert.doesNotMatch(text, /private thought|fake-key|fake-pass|fake-token/);
  assert.doesNotMatch(publicText('shown <reasoning>unfinished secret'), /unfinished secret/);
});

test('credential fields are scrubbed when DSH tool arguments arrive as a JSON string', () => {
  const row = publicEvent({
    seq: 8, type: 'tool/call', data: {
      turn: 1, step: 3, callId: 'encoded-args', name: 'call_plugin',
      arguments: JSON.stringify({ token: 'fake-local-token', nested: { secret: 'fake-secret' },
        headers: { 'set-cookie': 'fake-cookie' }, publicId: 'course-1' }),
    },
  });
  assert.doesNotMatch(JSON.stringify(row), /fake-local-token|fake-secret|fake-cookie/);
  assert.match(JSON.stringify(row), /course-1/);
});

test('shared memory uses optimistic revisions and sanitizes persisted notes', async t => {
  const root = await tempRoot(t, 'dsh-shared-memory-');
  assert.deepEqual(await readSharedMemory(root, 'ddl'), { key: 'ddl', revision: 0, text: '' });
  const first = await putSharedMemory(root, { key: 'ddl', text: '中文课周四 password=fake-pass', expectedRevision: 0 });
  assert.equal(first.revision, 1);
  assert.doesNotMatch(first.text, /fake-pass/);
  await assert.rejects(putSharedMemory(root, { key: 'ddl', text: 'stale overwrite', expectedRevision: 0 }), /conflict/);
  const second = await putSharedMemory(root, { key: 'ddl', text: '已核实 23:59', expectedRevision: 1 });
  assert.equal(second.revision, 2);
  assert.equal((await readSharedMemory(root, 'ddl')).text, '已核实 23:59');
  assert.deepEqual((await readSharedMemory(root)).entries.map(x => [x.key, x.revision]), [['ddl', 2]]);
  await assert.rejects(putSharedMemory(root, { key: '../escape', text: 'no', expectedRevision: 0 }), /Invalid memory key/);
  await assert.rejects(putSharedMemory(root, { key: 'ddl', text: 'no revision' }), /expectedRevision/);
});

test('shared memory detects a busy writer and cleans locks after a conflict', async t => {
  const root = await tempRoot(t, 'dsh-shared-memory-busy-');
  await putSharedMemory(root, { key: 'notes', text: 'first', expectedRevision: 0 });
  const lockPath = path.join(root, 'shared', 'memory', 'notes.lock');
  await fs.writeFile(lockPath, 'another writer');
  await assert.rejects(putSharedMemory(root, { key: 'notes', text: 'blocked', expectedRevision: 1 }), /busy/);
  assert.equal((await readSharedMemory(root, 'notes')).revision, 1);
  await fs.unlink(lockPath);
  await assert.rejects(putSharedMemory(root, { key: 'notes', text: 'stale', expectedRevision: 0 }), /conflict/);
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  const updated = await putSharedMemory(root, { key: 'notes', text: 'second', expectedRevision: 1 });
  assert.equal(updated.revision, 2);
});

test('concurrent shared-memory writers produce exactly one new revision', async t => {
  const root = await tempRoot(t, 'dsh-shared-memory-race-');
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    putSharedMemory(root, { key: 'race', text: `writer-${index}`, expectedRevision: 0 })));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  for (const result of outcomes.filter(x => x.status === 'rejected')) assert.match(result.reason.message, /busy|conflict/);
  const persisted = await readSharedMemory(root, 'race');
  assert.equal(persisted.revision, 1);
  assert.match(persisted.text, /^writer-[0-7]$/);
  await assert.rejects(fs.stat(path.join(root, 'shared', 'memory', 'race.lock')), { code: 'ENOENT' });
});

test('published memory access is limited to the summary and sanitized', async t => {
  const root = await tempRoot(t, 'dsh-published-memory-');
  assert.equal((await readPublishedCodexMemory(root)).available, false);
  await fs.mkdir(path.join(root, 'memories'));
  await fs.writeFile(path.join(root, 'memories', 'memory_summary.md'), '公开摘要 access_token=fake-access');
  const summary = await readPublishedCodexMemory(root);
  assert.equal(summary.available, true);
  assert.match(summary.text, /公开摘要/);
  assert.doesNotMatch(summary.text, /fake-access/);
});

test('capability requests are filtered by job and settle once', async t => {
  const { root, request } = await requestFixture(t, { jobId: 'job-one', sessionId: 'session-one' });
  await submitCodexRequest(root, { capability: 'plugin', name: 'portable-mcp', instruction: 'read course data' }, { jobId: 'job-two' });
  assert.deepEqual((await listCodexRequests(root, { jobId: 'job-one' })).map(x => x.id), [request.id]);
  const ack = await respondCodexRequest(root, { id: request.id, text: '查询结果 password=fake-pass' });
  assert.equal(ack.state, 'completed');
  const result = await getCodexRequest(root, request.id);
  assert.equal(result.state, 'completed');
  assert.doesNotMatch(result.response.text, /fake-pass/);
  assert.equal((await listCodexRequests(root, { jobId: 'job-one' })).length, 0);
  assert.equal((await listCodexRequests(root, { jobId: 'job-one', pendingOnly: false })).length, 1);
  await assert.rejects(respondCodexRequest(root, { id: request.id, text: 'second response' }), /cannot respond twice|completed/);
});

test('expired capability requests cannot be answered or remain pending', async t => {
  const { root, request } = await requestFixture(t);
  const file = path.join(root, 'shared', 'requests', request.id, 'request.json');
  await fs.writeFile(file, JSON.stringify({ ...request, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.equal((await getCodexRequest(root, request.id)).state, 'expired');
  assert.equal((await listCodexRequests(root)).length, 0);
  assert.equal((await waitCodexRequest(root, request.id, { timeoutSeconds: 1 })).state, 'expired');
  await assert.rejects(respondCodexRequest(root, { id: request.id, text: 'late' }), /expired/);
});

test('concurrent capability responders commit exactly one answer', async t => {
  const { root, request } = await requestFixture(t);
  const outcomes = await Promise.allSettled([
    respondCodexRequest(root, { id: request.id, text: 'answer-a' }),
    respondCodexRequest(root, { id: request.id, text: 'answer-b' }),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const rejection = outcomes.find(x => x.status === 'rejected');
  assert.match(rejection.reason.message, /EEXIST|already exists|cannot respond twice|completed/);
  const result = await getCodexRequest(root, request.id);
  assert.equal(result.state, 'completed');
  assert.ok(['answer-a', 'answer-b'].includes(result.response.text));
});

test('awaiting a pending request returns the published response and respects cancellation', async t => {
  const { root, request } = await requestFixture(t);
  const waiting = waitCodexRequest(root, request.id, { timeoutSeconds: 1 });
  const response = respondCodexRequest(root, { id: request.id, text: '本周两项 DDL', isError: false });
  await response;
  const result = await waiting;
  assert.equal(result.state, 'completed');
  assert.equal(result.response.text, '本周两项 DDL');
  const abort = new AbortController();
  abort.abort(new Error('stop waiting'));
  await assert.rejects(waitCodexRequest(root, request.id, { timeoutSeconds: 1, signal: abort.signal }), /stop waiting/);
});

test('failed responses terminate awaiting and empty waits leave pending requests intact', async t => {
  const { root, request } = await requestFixture(t);
  const pending = await waitCodexRequest(root, request.id, { timeoutSeconds: 0 });
  assert.equal(pending.state, 'pending');
  await respondCodexRequest(root, { id: request.id, text: 'plugin unavailable', isError: true });
  const failed = await waitCodexRequest(root, request.id, { timeoutSeconds: 1 });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.response.isError, true);
});
