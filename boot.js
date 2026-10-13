// Codex 派工桥 v2 —— DSH 插件入口
//
// 负责：
//   1. 启动队列 worker（worker.js）；
//   2. 为 bridge 拥有的会话加一条同步写入范围守卫：任务声明了 writeScope 时，
//      越界的 write/edit 会被直接拒绝（配合本机 approval=never 的无人值守场景）；
//   3. 可选注册本地 HTTP API（config.httpApi !== false），供 Codex 用 curl 长轮询。
//
// 配置来源：~/.local/share/dsh-codex-bridge/config.json（由 CLI `config --set k=v` 维护），
// profile 插件 config 可设置 pollMs / queueDir / httpApi / enforceWriteScope。

import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ROOT, activeSessions, bashWriteTargets, powershellWriteTargets, commandOf, touchedFiles, writeScopeAllows } from './protocol.js';
import { startBridge } from './worker.js';
import { HTTP_PATH, registerHttpApi, safeService, writeEndpointFile } from './http.mjs';

/** 同步守卫：返回字符串即拒绝该工具调用。仅对 bridge 会话生效。 */
export function writeScopeGuard(exec) {
  const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
  const entry = sessionId === undefined ? undefined : activeSessions.get(sessionId);
  if (!entry?.writeScope?.length) return undefined;
  const toolName = exec?.name ?? exec?.tool?.name ?? '';
  const candidates = touchedFiles(toolName, exec?.arguments).map(file => file.path);
  // 只提取可判定的字面路径；脚本、变量等动态写入不构成操作系统级沙箱。
  if (['bash', 'shell', 'pwsh', 'powershell'].includes(toolName)) {
    const command = commandOf(toolName, exec?.arguments);
    const powershell = ['pwsh', 'powershell'].includes(toolName) || (toolName === 'shell' && process.platform === 'win32');
    candidates.push(...(powershell ? powershellWriteTargets(command) : bashWriteTargets(command)));
  }
  for (const candidate of candidates) {
    const target = path.resolve(entry.cwd, candidate);
    if (!writeScopeAllows(entry.writeScope, target)) {
      return `写入超出任务 writeScope（${entry.writeScope.join(', ')}）：${target}`;
    }
  }
  return undefined;
}

/** 记录边界守卫的注册结果，便于 Codex/运维确认是否真的在生效。 */
function writeGuardMarker(root, payload) {
  fs.mkdir(root, { recursive: true, mode: 0o700 })
    .then(() => fs.writeFile(path.join(root, 'guard.json'), JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 }))
    .catch(() => {});
}

export const name = 'codex-task-bridge';
export const inject = ['sessionController', 'agents', 'sessions', 'workspaceRegistry'];

export function apply(ctx, config = {}) {
  const root = typeof config.queueDir === 'string' && config.queueDir ? config.queueDir : DEFAULT_ROOT;

  ctx.effect(() => {
    let disposed = false, stop;
    startBridge(ctx, root, Number.isInteger(config.pollMs) ? config.pollMs : undefined)
      .then(cleanup => { stop = cleanup; if (disposed) cleanup(); })
      .catch(error => ctx.logger.warn(`Codex bridge: ${String(error)}`));
    return () => { disposed = true; return stop?.(); };
  });

  // 执行边界守卫：只作用于 bridge 会话，且仅在任务声明了 writeScope 时生效。
  // 注意：未 inject 的服务在 cordis 里取属性可能抛错，因此这里必须容错——
  // 守卫注册失败绝不能拖垮整个插件（曾导致真机上插件刚激活就被回滚）。
  if (config.enforceWriteScope !== false) {
    try {
      const tools = safeService(ctx, 'tools');
      if (typeof tools?.guard === 'function') {
        ctx.effect(() => tools.guard(writeScopeGuard), 'codex-bridge write scope guard');
        writeGuardMarker(root, { registered: true, at: new Date().toISOString() });
      } else {
        writeGuardMarker(root, { registered: false, reason: 'tools.guard unavailable', at: new Date().toISOString() });
        ctx.logger?.warn?.('Codex bridge: tools.guard unavailable; write scope guard disabled');
      }
    } catch (error) {
      writeGuardMarker(root, { registered: false, reason: String(error), at: new Date().toISOString() });
      ctx.logger?.warn?.(`Codex bridge write scope guard: ${String(error)}`);
    }
  }

  if (config.httpApi !== false) {
    ctx.effect(() => {
      let registration;
      const webServer = safeService(ctx, 'webServer');
      if (typeof webServer?.register !== 'function') {
        ctx.logger?.info?.('Codex bridge: no web server service; HTTP API disabled');
        return;
      }
      try {
        registration = registerHttpApi(ctx, { root, config, webServer });
      } catch (error) {
        ctx.logger.warn(`Codex bridge HTTP API: ${String(error)}`);
        return;
      }
      if (!registration) return;
      const port = registration.port ?? webServer.port ?? null;
      writeEndpointFile(root, { port, path: HTTP_PATH }).catch(error => ctx.logger.warn(`Codex bridge endpoint file: ${String(error)}`));
      return () => registration.dispose?.();
    }, 'codex-bridge http api');
  }
}
