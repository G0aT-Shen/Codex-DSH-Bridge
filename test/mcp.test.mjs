import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {handleMessage, startMcpServer, TOOLS} from '../mcp.mjs';
import {createHttpHandler} from '../http.mjs';
import {writeScopeGuard} from '../boot.js';
import {activeSessions} from '../protocol.js';
import {tempRoot, until} from './helpers.mjs';

async function freshRoot(t, {alive = true} = {}) {
  const root = await tempRoot(t, 'dsh-bridge-mcp-');
  await fs.mkdir(path.join(root, 'jobs'), {recursive: true});
  await fs.mkdir(path.join(root, 'inbox'), {recursive: true});
  await fs.writeFile(path.join(root, 'token'), 'test-token', {mode: 0o600});
  if (alive) await fs.writeFile(path.join(root, 'health.json'), JSON.stringify({version: 2, pid: 1, updatedAt: new Date().toISOString(), maxConcurrent: 1, activeCount: 0, activeTasks: [], queued: 0, waitingInput: []}));
  return root;
}

test('mcp handshake, tool catalog and health call', async t => {
  const root = await freshRoot(t);
  const init = await handleMessage({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}}, {root});
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'dsh-codex-bridge');
  assert.ok(init.result.capabilities.tools);

  const list = await handleMessage({jsonrpc: '2.0', id: 2, method: 'tools/list'}, {root});
  const names = list.result.tools.map(tool => tool.name);
  assert.deepEqual(names, TOOLS.map(tool => tool.name));
  for (const name of ['bridge_wait', 'bridge_digest', 'bridge_steer', 'bridge_repair', 'bridge_answer', 'bridge_review']) {
    assert.ok(names.includes(name), `${name} must be exposed`);
  }

  const health = await handleMessage({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'bridge_health', arguments: {}}}, {root});
  assert.equal(health.result.isError, false);
  assert.equal(JSON.parse(health.result.content[0].text).alive, true);
  const healthData = JSON.parse(health.result.content[0].text);
  assert.equal(healthData.hasToken, true);
  assert.equal(Object.hasOwn(healthData, 'token'), false);
  assert.equal(health.result.content[0].text.includes('test-token'), false);
});

test('mcp submit accepts inline tasks and wait reports terminal state', async t => {
  const root = await freshRoot(t);
  const call = await handleMessage({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'bridge_submit', arguments: {task: {id: 'mcp-job', cwd: root, goal: 'g', plan: ['p'], acceptance: ['a']}},
  }}, {root});
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /mcp-job/);
  assert.deepEqual(await fs.readdir(path.join(root, 'inbox')), ['mcp-job.json']);

  await fs.mkdir(path.join(root, 'jobs', 'mcp-job'), {recursive: true});
  await fs.writeFile(path.join(root, 'jobs', 'mcp-job', 'status.json'), JSON.stringify({id: 'mcp-job', state: 'completed', steps: 4, maxSteps: 20, attempt: 1, review: {state: 'pending'}, outcome: 'completed'}));
  const wait = await handleMessage({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'bridge_wait', arguments: {id: 'mcp-job', timeoutSeconds: 1}}}, {root});
  const payload = JSON.parse(wait.result.content[0].text);
  assert.equal(payload.terminal, true);
  assert.equal(payload.state, 'completed');
  assert.equal(wait.result.isError, false);
});

test('mcp unknown tool and missing arguments return protocol errors', async t => {
  const root = await freshRoot(t);
  const unknown = await handleMessage({jsonrpc: '2.0', id: 6, method: 'tools/call', params: {name: 'nope', arguments: {}}}, {root});
  assert.equal(unknown.error.code, -32602);
  const missing = await handleMessage({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'bridge_status', arguments: {}}}, {root});
  assert.equal(missing.error.code, -32602);
  const method = await handleMessage({jsonrpc: '2.0', id: 8, method: 'does/not/exist'}, {root});
  assert.equal(method.error.code, -32601);
  assert.equal(await handleMessage({jsonrpc: '2.0', method: 'notifications/initialized'}, {root}), null);
});

test('mcp exposes job resources for reading', async t => {
  const root = await freshRoot(t);
  await fs.mkdir(path.join(root, 'jobs', 'res-job'), {recursive: true});
  await fs.writeFile(path.join(root, 'jobs', 'res-job', 'status.json'), JSON.stringify({id: 'res-job', state: 'running', steps: 2}));
  const list = await handleMessage({jsonrpc: '2.0', id: 9, method: 'resources/list'}, {root});
  assert.equal(list.result.resources[0].uri, 'dsh-bridge://jobs/res-job');
  const read = await handleMessage({jsonrpc: '2.0', id: 10, method: 'resources/read', params: {uri: 'dsh-bridge://jobs/res-job'}}, {root});
  assert.equal(JSON.parse(read.result.contents[0].text).status.state, 'running');
});

test('mcp stdio loop handles ndjson, parse errors and progress notifications', async t => {
  const root = await freshRoot(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', chunk => chunks.push(String(chunk)));
  const server = startMcpServer({root, input, output});
  input.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {}}) + '\n');
  input.write('{not json\n');
  input.write(JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'bridge_health', arguments: {}, _meta: {progressToken: 'tok'}}}) + '\n');
  await until(() => Promise.resolve(chunks.join('')), text => text.includes('"id":2'));
  input.end();
  await server;
  const lines = chunks.join('').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].result.serverInfo.name, 'dsh-codex-bridge');
  assert.equal(lines[1].error.code, -32700);
  assert.ok(lines.some(message => message.method === 'notifications/progress' && message.params.progressToken === 'tok'));
  assert.ok(lines.some(message => message.id === 2 && message.result));
});

// ------------------------------------------------------------------ HTTP API

function fakeRequest({url = '/codex-bridge/health', method = 'GET', headers = {}, body = ''} = {}) {
  return {
    url, method, headers,
    async *[Symbol.asyncIterator]() { if (body) yield body; },
  };
}

function fakeResponse() {
  return {
    statusCode: null, body: '', headers: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body ?? ''; },
  };
}

test('http api enforces local host and bearer token', async t => {
  const root = await freshRoot(t);
  await fs.rm(path.join(root, 'token'), {force: true});
  const noTokenFile = createHttpHandler({root});
  const unavailable = fakeResponse();
  await noTokenFile(fakeRequest({headers: {host: '127.0.0.1:19387'}}), unavailable);
  assert.equal(unavailable.statusCode, 503, 'missing token file must fail closed');

  await fs.writeFile(path.join(root, 'token'), 'file-token', {mode: 0o600});
  const fromFile = createHttpHandler({root});
  const wrong = fakeResponse();
  await fromFile(fakeRequest({headers: {host: '127.0.0.1:19387', authorization: 'Bearer nope'}}), wrong);
  assert.equal(wrong.statusCode, 401, 'token from file must be enforced');
  const right = fakeResponse();
  await fromFile(fakeRequest({headers: {host: '127.0.0.1:19387', authorization: 'Bearer file-token'}}), right);
  assert.equal(right.statusCode, 200);

  const handler = createHttpHandler({root, token: 'test-token'});

  const foreign = fakeResponse();
  await handler(fakeRequest({headers: {host: 'evil.example.com'}}), foreign);
  assert.equal(foreign.statusCode, 403);

  const noToken = fakeResponse();
  await handler(fakeRequest({headers: {host: '127.0.0.1:19387'}}), noToken);
  assert.equal(noToken.statusCode, 401);

  const ok = fakeResponse();
  await handler(fakeRequest({headers: {host: '127.0.0.1:19387', authorization: 'Bearer test-token'}}), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).data.alive, true);

  const unknown = fakeResponse();
  await handler(fakeRequest({url: '/codex-bridge/destroy', headers: {host: 'localhost', authorization: 'Bearer test-token'}}), unknown);
  assert.equal(unknown.statusCode, 400);
});

test('http api submits tasks from a json body', async t => {
  const root = await freshRoot(t);
  const handler = createHttpHandler({root, token: 'test-token'});
  const res = fakeResponse();
  await handler(fakeRequest({
    url: '/codex-bridge/submit',
    method: 'POST',
    headers: {host: '127.0.0.1:19387', authorization: 'Bearer test-token'},
    body: JSON.stringify({task: {id: 'http-job', cwd: root, goal: 'g', plan: ['p'], acceptance: ['a']}}),
  }), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.exitCode, 0);
  assert.deepEqual(await fs.readdir(path.join(root, 'inbox')), ['http-job.json']);
});

// ------------------------------------------------------------------ 写入范围守卫

test('write scope guard blocks out-of-scope writes only for bridge sessions', () => {
  const sessionId = 'session-guarded';
  activeSessions.set(sessionId, {jobId: 'j', cwd: '/tmp/project', writeScope: ['/tmp/project/src']});
  const exec = (name, args) => ({name, arguments: JSON.stringify(args), agent: {session: {id: sessionId}}});

  assert.equal(writeScopeGuard(exec('write', {file_path: '/tmp/project/src/a.js'})), undefined);
  assert.match(writeScopeGuard(exec('edit', {file_path: '/tmp/project/README.md'})), /超出任务 writeScope/);
  assert.match(writeScopeGuard(exec('write', {file_path: '../outside.txt'})), /超出任务 writeScope/);
  assert.equal(writeScopeGuard(exec('read', {file_path: '/etc/passwd'})), undefined, 'reads are not restricted');
  assert.equal(writeScopeGuard({name: 'write', arguments: JSON.stringify({file_path: '/anywhere'}), agent: {session: {id: 'someone-else'}}}), undefined);

  activeSessions.set('session-free', {jobId: 'j2', cwd: '/tmp/project', writeScope: null});
  assert.equal(writeScopeGuard({name: 'write', arguments: JSON.stringify({file_path: '/anywhere'}), agent: {session: {id: 'session-free'}}}), undefined);
  activeSessions.delete(sessionId);
  activeSessions.delete('session-free');
});

test('bridge_read exposes only files recorded in evidence and returns fresh hashes', async t => {
  const root = await freshRoot(t);
  const job = path.join(root, 'jobs', 'read-job');
  const artifact = path.join(root, 'artifact.txt');
  const outsider = path.join(root, 'secret.txt');
  await fs.mkdir(job, {recursive: true});
  await fs.writeFile(artifact, 'artifact-content');
  await fs.writeFile(outsider, 'do-not-read');
  await fs.writeFile(path.join(job, 'evidence.json'), JSON.stringify({
    files: [{path: artifact, exists: true, sha256: 'x'}],
    commands: [], denials: [], steers: [], usage: {},
  }));

  const listing = await handleMessage({jsonrpc: '2.0', id: 20, method: 'tools/call', params: {name: 'bridge_read', arguments: {id: 'read-job'}}}, {root});
  assert.deepEqual(JSON.parse(listing.result.content[0].text).files, [artifact]);

  const read = await handleMessage({jsonrpc: '2.0', id: 21, method: 'tools/call', params: {name: 'bridge_read', arguments: {id: 'read-job', path: artifact}}}, {root});
  const payload = JSON.parse(read.result.content[0].text);
  assert.equal(payload.content, 'artifact-content');
  assert.equal(payload.sha256.length, 64);

  const denied = await handleMessage({jsonrpc: '2.0', id: 22, method: 'tools/call', params: {name: 'bridge_read', arguments: {id: 'read-job', path: outsider}}}, {root});
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /不在该任务的证据清单内/);
});
