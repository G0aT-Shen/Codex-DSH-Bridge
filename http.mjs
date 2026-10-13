// Codex 派工桥 v2 —— 本地 HTTP API（可选通道）
//
// 为什么需要：MCP 需要一次性注册；HTTP 路由让 Codex 直接用 curl 就能阻塞等待，
// 也可以在 MCP 不可用时兜底。
// 安全：只接受本机 Host、必须带 Bearer token（0600 文件），命令白名单来自 cli.execute。

import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ROOT, queueDir } from './protocol.js';
import { execute } from './cli.mjs';

export const HTTP_PATH = '/codex-bridge';
const ALLOWED_COMMANDS = new Set(['health', 'submit', 'list', 'status', 'progress', 'watch', 'tail', 'digest', 'result', 'read', 'steer', 'repair', 'resume', 'cancel', 'review', 'questions', 'answer', 'config']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** cordis 服务必须通过 ctx.get 访问：未 inject 的属性访问会抛错。 */
export function safeService(ctx, name) {
  try { const value = ctx.get?.(name); if (value !== undefined) return value; } catch { /* fall through */ }
  try { return ctx[name]; } catch { return undefined; }
}

export async function readToken(root = DEFAULT_ROOT) {
  try { return (await fs.readFile(path.join(root, 'token'), 'utf8')).trim(); } catch { return null; }
}

/** Build the request handler; exported so it can be unit-tested without a web server. */
export function createHttpHandler({ root = DEFAULT_ROOT, token = null } = {}) {
  return async function handler(req, res) {
    const send = (code, payload) => {
      const body = JSON.stringify(payload, null, 2);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      const host = String(req.headers.host ?? '').split(':')[0].replace(/^\[|\]$/g, '');
      if (!LOCAL_HOSTS.has(host)) return send(403, { error: 'bridge HTTP API is local-only' });
      // token 每次请求都重新解析：worker 可能在路由注册之后才生成 token。
      const expected = token ?? await readToken(root);
      if (!expected) return send(503, { error: 'bridge token unavailable' });
      const header = String(req.headers.authorization ?? '');
      if (header !== `Bearer ${expected}`) return send(401, { error: 'missing or invalid bearer token' });
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(HTTP_PATH)) return send(404, { error: 'not found' });
      const segments = url.pathname.slice(HTTP_PATH.length).split('/').filter(Boolean);
      const command = segments[0] ?? url.searchParams.get('command');
      if (!command || !ALLOWED_COMMANDS.has(command)) return send(400, { error: `unknown command: ${command ?? ''}` });

      const argv = [command];
      const id = url.searchParams.get('id') ?? segments[1];
      if (id && ['status', 'progress', 'watch', 'tail', 'digest', 'result', 'read', 'steer', 'repair', 'resume', 'cancel', 'review', 'answer'].includes(command)) argv.push(id);
      for (const key of ['timeout', 'seq', 'lines']) {
        const value = url.searchParams.get(key);
        if (value !== null) argv.push(key === 'lines' ? '-n' : `--${key}`, value);
      }
      if (url.searchParams.get('fresh') === 'true') argv.push('--fresh');
      if (url.searchParams.get('all') === 'true') argv.push('--all');
      if (!argv.includes('--json')) argv.push('--json');

      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 512 * 1024) return send(413, { error: 'request body too large' });
      }
      const payload = body.trim() ? JSON.parse(body) : {};
      if (payload.args && Array.isArray(payload.args)) argv.push(...payload.args.map(String));
      if (payload.task || payload.tasks) argv.push('--inline', JSON.stringify(payload.tasks ? { tasks: payload.tasks } : payload.task));
      if (payload.text) argv.push(String(payload.text));
      if (payload.note) argv.push(String(payload.note));
      if (payload.verdict) argv.push(String(payload.verdict));

      const result = await execute(argv, { root });
      let data;
      try { data = JSON.parse(result.stdout); } catch { data = undefined; }
      return send(200, { exitCode: result.exitCode, command, data, output: data === undefined ? result.stdout : undefined });
    } catch (error) {
      return send(500, { error: String(error?.message ?? error) });
    }
  };
}

/** Register the route on the desktop web server when the service exists. */
export function registerHttpApi(ctx, { root = DEFAULT_ROOT, config = {}, webServer = undefined } = {}) {
  webServer ??= safeService(ctx, 'webServer');
  if (!webServer?.register || config.httpApi === false) return undefined;
  const dispose = webServer.register({ kind: 'prefix', path: HTTP_PATH, handler: createHttpHandler({ root }) });
  // token 可能在 worker 启动时才生成，这里补一次并写发现文件。
  const port = webServer.port ?? null;
  return { dispose, port, token: () => readToken(root) };
}

export async function writeEndpointFile(root, { port, path: routePath = HTTP_PATH } = {}) {
  const token = await readToken(root);
  const payload = { url: port ? `http://127.0.0.1:${port}${routePath}` : null, port, path: routePath, tokenFile: path.join(root, 'token'), hasToken: token !== null, updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'http.json'), JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  return payload;
}

export { queueDir };
