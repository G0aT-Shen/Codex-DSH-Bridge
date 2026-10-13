import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { apply } from '../shared-plugin/boot.js';
import { activeSessions, atomicJson, readJson } from '../protocol.js';
import { execute } from '../cli.mjs';
import { handleMessage } from '../mcp.mjs';
import { callSharedHost, getCodexRequest, respondCodexRequest, submitCodexRequest } from '../shared.mjs';
import { pause, until } from './helpers.mjs';

const publicMessage = (seq, text) => ({
  seq, type: 'assistant/message', time: 1000 + seq,
  data: { message: { content: [{ type: 'text', text }] } },
});

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-shared-host-'));
  const codexHome = path.join(root, 'fake-codex-home');
  const token = 'isolated-test-bearer';
  await fs.writeFile(path.join(root, 'token'), token, { mode: 0o600 });
  const tools = new Map();
  const calls = { titles: [], lists: [], observations: [], disposed: 0, routeDisposed: 0 };
  let route, stop;
  const webServer = {
    port: 17453,
    register(value) {
      assert.equal(value.kind, 'prefix');
      assert.equal(value.path, '/codex-shared');
      route = value;
      return () => { calls.routeDisposed++; };
    },
  };
  const ctx = {
    logger: { warn() {} },
    get: name => name === 'webServer' ? webServer : undefined,
    tools: {
      register(definition) {
        assert.ok(!tools.has(definition.name), `duplicate ${definition.name}`);
        tools.set(definition.name, definition);
      },
      view: () => ({ visible: new Map([
        ...tools,
        ['mcp__codex_lms__courses', {}],
      ]) }),
    },
    skills: {
      snapshot: async ({ cwd, signal }) => {
        signal.throwIfAborted();
        return { complete: true, skills: [{ name: 'canvas-desktop', description: `Read ${cwd}`, provider: 'codex-shared', privateDetail: 'not in inventory' }] };
      },
      get: async (name, { signal }) => {
        signal.throwIfAborted();
        return name === 'canvas-desktop'
          ? { name, provider: 'codex-shared', content: 'Read logged-in Canvas.', resourceBase: path.join(root, 'skills', name) }
          : null;
      },
    },
    sessionController: {
      list: async (args, signal) => {
        signal.throwIfAborted();
        calls.lists.push(args);
        return { items: [
          { sessionId: 'session-one', cwd: root, running: true, updatedAt: 1000 },
          { sessionId: 'session-two', cwd: root, running: false, updatedAt: 1001 },
          { sessionId: 'session-three', cwd: root, running: false, updatedAt: 1002 },
        ] };
      },
    },
    sessionQuery: {
      readTitleSnapshots: async (ids, signal) => {
        signal.throwIfAborted(); calls.titles.push(ids);
        return [
          { sessionId: 'session-one', status: 'fulfilled', value: { title: 'First password=private-title' } },
          { sessionId: 'session-two', status: 'fulfilled', value: { title: { text: 'Second' } } },
          { sessionId: 'session-three', status: 'rejected', reason: new Error('unavailable') },
        ];
      },
      observeSession: async (sessionId, options) => {
        options.signal.throwIfAborted(); calls.observations.push({ sessionId, options });
        return {
          events: [publicMessage(0, 'one'), publicMessage(1, 'two')],
          [Symbol.dispose]() { calls.disposed++; },
        };
      },
    },
    effect(effect) { stop = effect(); },
  };
  for (const [key, value] of Object.entries(overrides)) Object.assign(ctx[key], value);
  apply(ctx, { queueDir: root, codexHome });
  const markerFile = path.join(root, 'shared', 'host.json');
  await until(() => readJson(markerFile, null), marker => marker?.alive === true);
  t.after(async () => {
    stop?.();
    try { await until(() => readJson(markerFile, null), marker => marker?.alive === false); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  return { root, codexHome, token, tools, ctx, calls, route: () => route };
}

async function request(f, payload, options = {}) {
  const req = Readable.from([options.rawBody ?? JSON.stringify(payload)]);
  req.headers = {
    host: options.host ?? '127.0.0.1:17453',
    ...(options.auth === null ? {} : { authorization: options.auth ?? `Bearer ${f.token}` }),
  };
  req.socket = { remoteAddress: options.address ?? '127.0.0.1' };
  req.method = options.method ?? 'POST';
  req.url = options.url ?? '/codex-shared';
  const res = new EventEmitter();
  let status, body;
  res.writeHead = (code, headers) => { status = code; assert.equal(headers['cache-control'], 'no-store'); };
  res.end = text => { body = JSON.parse(text); };
  await f.route().handler(req, res);
  assert.equal(res.listenerCount('close'), 0, 'response cancellation listener is removed');
  return { status, body };
}

function mockHostFetch(t, f) {
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:17453/codex-shared');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, `Bearer ${f.token}`);
    assert.ok(options.signal instanceof AbortSignal);
    const result = await request(f, null, { rawBody: options.body, auth: options.headers.authorization });
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
  });
}

const toolCall = async (root, name, args = {}) => {
  const response = await handleMessage({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }, { root });
  assert.equal(response.result?.isError, false, response.result?.content?.[0]?.text ?? JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
};

test('shared host requires both loopback origin/address and a valid local bearer', async t => {
  const f = await fixture(t);
  const payload = { command: 'status' };
  for (const options of [
    { host: 'remote.example:17453' },
    { address: '192.0.2.1' },
    { host: '127.0.0.1.attacker.example' },
  ]) assert.equal((await request(f, payload, options)).status, 403);
  assert.equal((await request(f, payload, { auth: null })).status, 401);
  assert.equal((await request(f, payload, { auth: 'Bearer wrong' })).status, 401);
  const valid = await request(f, payload, { host: '[::1]:17453', address: '::1' });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.portableMcp, { lms: 1 });
  assert.equal((await request(f, payload, { method: 'GET' })).status, 404);
  assert.equal((await request(f, payload, { url: '/codex-shared/unlisted' })).status, 404);
  assert.equal((await request(f, payload, { rawBody: 'x'.repeat(65537) })).status, 413);
  await fs.unlink(path.join(f.root, 'token'));
  assert.equal((await request(f, payload)).status, 401, 'token is re-read on each request');
});

test('shared status counts arbitrary mirrored MCP servers without exposing their config', async t => {
  const f = await fixture(t);
  for (const name of ['mcp__codex_files__read', 'mcp__codex_files__list', 'mcp__codex_my_server__search', 'mcp__other__ignore']) {
    f.tools.set(name, { privateConfig: 'must not appear' });
  }
  const result = await request(f, { command: 'status' });
  assert.deepEqual(result.body.portableMcp, { lms: 1, files: 2, my_server: 1 });
  assert.ok(!JSON.stringify(result.body).includes('must not appear'));
});

test('sessions uses controller items/sessionId and fulfilled title snapshots', async t => {
  const f = await fixture(t);
  const result = await request(f, { command: 'sessions' });
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.lists, [{}]);
  assert.deepEqual(f.calls.titles, [['session-one', 'session-two', 'session-three']]);
  assert.deepEqual(result.body.sessions.map(s => [s.id, s.title, s.running]), [
    ['session-one', 'First password=[redacted]', true], ['session-two', 'Second', false], ['session-three', '', false],
  ]);
  assert.equal(result.body.hasMore, false);
  assert.doesNotMatch(JSON.stringify(result.body), /private-title|reason/);
});

test('session enumeration bounds titles and rows to 100 and reports more items', async t => {
  let requestedIds;
  const f = await fixture(t, {
    sessionController: { list: async () => ({ items: Array.from({ length: 105 }, (_, index) => ({ sessionId: `s-${index}` })) }) },
    sessionQuery: { readTitleSnapshots: async ids => { requestedIds = ids; return []; } },
  });
  const { body } = await request(f, { command: 'sessions' });
  assert.equal(body.sessions.length, 100);
  assert.equal(requestedIds.length, 100);
  assert.equal(body.hasMore, true);
});

test('events expose text/tool operations, remove thoughts and secrets, and dispose the lease', async t => {
  const f = await fixture(t, { sessionQuery: {
    observeSession: async (sessionId, options) => {
      f.calls.observations.push({ sessionId, options });
      return { events: [
        { seq: 0, type: 'assistant/attempt', data: { text: 'hidden-attempt' } },
        { seq: 1, type: 'assistant/message', data: { message: { content: [
          { type: 'reasoning', text: 'hidden-thought' }, { type: 'text', text: 'visible Bearer fake-bearer' },
        ], source: { replayState: 'hidden-replay' } } } },
        { seq: 2, type: 'tool/call', data: { callId: 'call-one', name: 'read_course', arguments: { cookie: 'fake-cookie', courseId: 5 } } },
        publicMessage(3, 'last'),
      ], [Symbol.dispose]() { f.calls.disposed++; } };
    },
  } });
  const first = await request(f, { command: 'events', args: { sessionId: 'session-one', limit: 2 } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.events.map(row => row.seq), [1, 2]);
  assert.equal(first.body.nextCursor, 3);
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.events[0].omittedNonTextBlocks, 1);
  assert.equal(first.body.events[1].arguments.courseId, 5);
  assert.doesNotMatch(JSON.stringify(first.body), /hidden-thought|hidden-attempt|hidden-replay|fake-bearer|fake-cookie/);
  const second = await request(f, { command: 'events', args: { sessionId: 'session-one', cursor: first.body.nextCursor } });
  assert.deepEqual(second.body.events.map(row => row.text), ['last']);
  assert.equal(second.body.hasMore, false);
  assert.equal(f.calls.disposed, 2);
  assert.ok(f.calls.observations.every(x => x.options.projectionMode === 'none' && x.options.signal instanceof AbortSignal));
});

test('event processing failure still disposes its observation and scrubs the error', async t => {
  const f = await fixture(t, { sessionQuery: {
    observeSession: async () => ({
      events: [{ get seq() { throw new Error('bad event password=error-secret'); } }],
      [Symbol.dispose]() { f.calls.disposed++; },
    }),
  } });
  const result = await request(f, { command: 'events', args: { sessionId: 'session-one' } });
  assert.equal(result.status, 400);
  assert.equal(f.calls.disposed, 1);
  assert.doesNotMatch(result.body.error, /error-secret/);
  const invalid = await request(f, { command: 'events', args: { sessionId: 'session-one', cursor: -1 } });
  assert.equal(invalid.status, 400);
  assert.equal(f.calls.disposed, 1, 'invalid cursor is rejected before observing');
});

test('DSH registers canonical-value tools and preserves active bridge job attribution', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.tools.keys()], ['codex_shared_memory', 'codex_shared_memory_put', 'codex_request', 'codex_request_wait']);
  for (const definition of f.tools.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(typeof definition.output.render, 'function');
  }
  const signal = new AbortController().signal;
  const exec = { signal, agent: { session: { id: 'shared-host-session' } } };
  activeSessions.set(exec.agent.session.id, { jobId: 'host-job' });
  t.after(() => activeSessions.delete(exec.agent.session.id));
  const put = f.tools.get('codex_shared_memory_put');
  const note = await put.execute({ key: 'ddl', text: 'Thursday password=note-secret', expectedRevision: 0 }, exec);
  assert.equal(note.revision, 1);
  assert.equal(note.author, 'DSH:shared-host-session');
  assert.equal('content' in note, false, 'execute returns the canonical value, not a display wrapper');
  assert.deepEqual(JSON.parse(put.output.render({}, note)[0].text), note);
  const memory = await f.tools.get('codex_shared_memory').execute({ key: 'ddl' }, exec);
  assert.equal(memory.shared.revision, 1);
  assert.equal(memory.published.available, false);
  assert.doesNotMatch(JSON.stringify(memory), /note-secret/);
  const req = await f.tools.get('codex_request').execute({ capability: 'skill', name: 'canvas-desktop', instruction: 'Read DDL.' }, exec);
  assert.equal(req.jobId, 'host-job');
  assert.equal(req.sessionId, 'shared-host-session');
  assert.equal(req.state, 'pending');
  assert.deepEqual(await getCodexRequest(f.root, req.id), req);
  const pending = await f.tools.get('codex_request_wait').execute({ id: req.id, timeoutSeconds: 0 }, exec);
  assert.equal(pending.state, 'pending');
  await respondCodexRequest(f.root, { id: req.id, text: 'Read completed.' });
  const completed = await f.tools.get('codex_request_wait').execute({ id: req.id, timeoutSeconds: 0 }, exec);
  assert.equal(completed.response.text, 'Read completed.');
  const aborted = new AbortController(); aborted.abort(new Error('tool cancelled'));
  await assert.rejects(put.execute({ key: 'cancelled', text: 'must not write', expectedRevision: 0 }, { signal: aborted.signal }), /tool cancelled/);
  await assert.rejects(fs.stat(path.join(f.root, 'shared', 'memory', 'cancelled.json')), { code: 'ENOENT' });
});

test('CLI shared commands use the host contract and reject a non-local marker', async t => {
  const f = await fixture(t);
  const mocked = mockHostFetch(t, f);
  for (const [argv, expected] of [
    [['shared-status', '--json'], value => value.tools.includes('codex_request')],
    [['shared-skills', '--json'], value => value.skills[0].name === 'canvas-desktop'],
    [['shared-skill', 'canvas-desktop', '--json'], value => value.content === 'Read logged-in Canvas.'],
    [['sessions', '--json'], value => value.sessions[0].id === 'session-one'],
    [['session-events', 'session-one', '--cursor', '1', '-n', '1', '--json'], value => value.events[0].text === 'two'],
  ]) {
    const result = await execute(argv, { root: f.root });
    assert.equal(result.exitCode, 0);
    assert.equal(expected(JSON.parse(result.stdout)), true, argv.join(' '));
  }
  assert.equal(mocked.mock.callCount(), 5);
  const markerFile = path.join(f.root, 'shared', 'host.json');
  const originalMarker = await readJson(markerFile);
  try {
    await atomicJson(markerFile, { alive: true, url: 'http://remote.example/codex-shared' });
    await assert.rejects(callSharedHost(f.root, 'status'), /Invalid local/);
    assert.equal(mocked.mock.callCount(), 5, 'remote marker is rejected before fetch');
  } finally { await atomicJson(markerFile, originalMarker); }
});

test('watch wakes only for its own Codex request and keeps the running job non-terminal', async t => {
  const f = await fixture(t);
  const jobId = 'watch-host-job';
  const dir = path.join(f.root, 'jobs', jobId);
  await fs.mkdir(dir, { recursive: true });
  await atomicJson(path.join(dir, 'status.json'), { id: jobId, state: 'running', steps: 2, review: { state: 'pending' } });
  await submitCodexRequest(f.root, { capability: 'plugin', name: 'other', instruction: 'Other job.' }, { jobId: 'different-job' });
  let settled = false;
  const watching = execute(['watch', jobId, '--timeout', '4', '--json'], { root: f.root }).then(value => { settled = true; return value; });
  await pause(100);
  assert.equal(settled, false, 'an unrelated pending request cannot wake this job');
  const req = await submitCodexRequest(f.root, { capability: 'skill', name: 'canvas-desktop', instruction: 'Read DDL.' }, { jobId });
  const result = await watching;
  assert.equal(result.exitCode, 0);
  const value = JSON.parse(result.stdout);
  assert.equal(value.state, 'running');
  assert.equal(value.terminal, false);
  assert.deepEqual(value.requests.map(x => x.id), [req.id]);
  await respondCodexRequest(f.root, { id: req.id, text: 'done' });
  const next = await execute(['watch', jobId, '--timeout', '1', '--json'], { root: f.root });
  assert.equal(next.exitCode, 2, 'an answered request no longer wakes the still-running job');
  assert.deepEqual(JSON.parse(next.stdout).requests, []);
});

test('new MCP schemas and tools/call reach shared host, memory, requests, and public job events', async t => {
  const f = await fixture(t);
  mockHostFetch(t, f);
  const listed = await handleMessage({ id: 1, method: 'tools/list' }, { root: f.root });
  const newNames = ['bridge_events', 'bridge_requests', 'bridge_respond', 'bridge_memory', 'bridge_memory_put', 'bridge_sessions', 'bridge_session_events'];
  for (const name of newNames) {
    const tool = listed.result.tools.find(x => x.name === name);
    assert.ok(tool, name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const bad = await handleMessage({ id: 2, method: 'tools/call', params: { name: 'bridge_session_events', arguments: {} } }, { root: f.root });
  assert.equal(bad.error.code, -32602);
  const missingPut = await handleMessage({ id: 3, method: 'tools/call', params: { name: 'bridge_memory_put', arguments: { key: 'x', text: 'x' } } }, { root: f.root });
  assert.match(missingPut.error.message, /expectedRevision/);
  const note = await toolCall(f.root, 'bridge_memory_put', { key: 'mcp-note', text: 'Shared fact.', expectedRevision: 0 });
  assert.equal(note.revision, 1);
  assert.equal((await toolCall(f.root, 'bridge_memory', { key: 'mcp-note' })).text, 'Shared fact.');
  assert.equal((await toolCall(f.root, 'bridge_sessions')).sessions[0].id, 'session-one');
  assert.equal((await toolCall(f.root, 'bridge_session_events', { sessionId: 'session-one', cursor: 1, limit: 1 })).events[0].text, 'two');
  const req = await submitCodexRequest(f.root, { capability: 'skill', name: 'canvas-desktop', instruction: 'Read DDL.' }, { jobId: 'mcp-job' });
  assert.deepEqual((await toolCall(f.root, 'bridge_requests', { jobId: 'mcp-job' })).map(x => x.id), [req.id]);
  assert.equal((await toolCall(f.root, 'bridge_respond', { id: req.id, text: 'Completed.' })).state, 'completed');
  assert.equal((await getCodexRequest(f.root, req.id)).response.text, 'Completed.');
  const jobDir = path.join(f.root, 'jobs', 'mcp-job');
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, 'events.jsonl'), [
    { seq: 0, type: 'assistant/attempt', data: { text: 'hidden-thought' } },
    publicMessage(1, 'public message password=event-secret'),
  ].map(x => JSON.stringify(x) + '\n').join(''));
  const events = await toolCall(f.root, 'bridge_events', { id: 'mcp-job', limit: 1 });
  assert.deepEqual(events.events.map(x => x.seq), [1]);
  assert.doesNotMatch(JSON.stringify(events), /hidden-thought|event-secret/);
});
