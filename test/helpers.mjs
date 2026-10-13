// 测试用假 DSH 宿主：模拟 sessionController / agents / sessions / workspaceRegistry
// 以及会话事件流，用于在不启动桌面端的情况下验证 worker 的协同行为。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(read, predicate, { tries = 250, interval = 20 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch { /* keep polling */ }
    await pause(interval);
  }
  throw new Error(`Timed out; last value: ${JSON.stringify(last)?.slice(0, 400)}`);
}

export async function tempRoot(t, prefix = 'dsh-bridge-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  return root;
}

/**
 * 建立一个隔离的队列根目录 + 假宿主 + 运行中的 worker，并保证先停 worker 再删目录。
 */
export async function startFixture(t, { script, config, forkSupported, pollMs = 20, prefix = 'dsh-bridge-' } = {}) {
  const { startBridge } = await import('../worker.js');
  const { atomicJson, loadConfig } = await import('../protocol.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  if (config) await atomicJson(path.join(root, 'config.json'), config);
  const fake = makeFake({ script, forkSupported });
  const stop = await startBridge(fake.ctx, root, pollMs);
  t.after(async () => {
    await stop().catch(() => {});
    await pause(60);
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const readStatus = id => fs.readFile(path.join(root, 'jobs', id, 'status.json'), 'utf8').then(JSON.parse);
  const readHealth = () => fs.readFile(path.join(root, 'health.json'), 'utf8').then(JSON.parse);
  const readArtifact = (id, name) => fs.readFile(path.join(root, 'jobs', id, name), 'utf8');
  return { root, fake, stop, readStatus, readHealth, readArtifact, config: await loadConfig(root) };
}

/** Default turn: one step, one bash call, a final message. */
export async function defaultScript({ push, text, finalText }) {
  const step = 1;
  push('step/start', { turn: 1, step });
  push('tool/call', { turn: 1, step, callId: `call-${Math.random().toString(16).slice(2)}`, name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) });
  push('tool/result', { turn: 1, step, callId: 'x', message: { content: [{ type: 'text', text: 'hi\n[exit code: 0]' }], isError: false } });
  push('assistant/message', { turn: 1, step, message: { content: [{ type: 'text', text: finalText ?? text.slice(0, 40) }] } });
  push('step/end', { turn: 1, step });
}

export function makeFake({ script, forkSupported = true } = {}) {
  const listeners = [];
  const state = {
    agents: new Map(),
    log: new Map(),
    created: [],
    prompts: [],
    steers: [],
    cancels: 0,
    forks: 0,
    renames: [],
    warnings: [],
    turns: 0,
    running: new Set(),
  };
  const runScript = script ?? defaultScript;

  function createAgent(id, { inherited = [] } = {}) {
    if (!state.log.has(id)) state.log.set(id, [...inherited]);
    const events = state.log.get(id);
    let resolveIdle = null;
    let idle = Promise.resolve();
    const agent = {
      id,
      status: 'idle',
      _cancelled: false,
      session: {
        id,
        get seq() { return events.length; },
        eventAt: index => events[index],
        snapshotEvents: () => [...events],
        inheritedEventCount: inherited.length,
      },
      inbox: { nextTurn: [], nextStep: [] },
      whenIdle: () => idle,
      cancel() {
        state.cancels++;
        agent._cancelled = true;
        push('turn/end', { reason: { kind: 'cancelled' } });
        agent.status = 'idle';
        state.running.delete(id);
        const resolve = resolveIdle; resolveIdle = null; idle = Promise.resolve(); resolve?.();
      },
    };
    function push(type, data) {
      const event = { type, data, seq: events.length };
      events.push(event);
      for (const [name, listener] of listeners) if (name === 'session/event') listener(agent.session, event);
      return event;
    }
    agent.push = push;
    function begin() {
      idle = new Promise(resolve => { resolveIdle = resolve; });
    }
    function complete() {
      if (!agent._cancelled) push('turn/end', { reason: { kind: 'completed' } });
      agent._cancelled = false;
      agent.status = 'idle';
      state.running.delete(id);
      const resolve = resolveIdle; resolveIdle = null; idle = Promise.resolve(); resolve?.();
    }
    agent.startTurn = text => {
      agent.status = 'running';
      state.running.add(id);
      begin();
      const turnNo = ++state.turns;
      agent.push('turn/start', { turn: turnNo });
      agent.push('user/message', { turn: turnNo, message: { content: [{ type: 'text', text }] }, source: { kind: 'user' } });
      const api = {
        push, text, turn: turnNo, agent,
        steers: () => state.steers.filter(item => item.sessionId === id).map(item => item.text),
        stopRequested: () => agent._cancelled,
        sleep: pause,
      };
      Promise.resolve()
        .then(() => runScript(api))
        .catch(error => { state.warnings.push(String(error)); })
        .finally(() => complete());
      return api;
    };
    state.agents.set(id, agent);
    return agent;
  }

  function ensureAgent(sessionId) {
    return state.agents.get(sessionId) ?? createAgent(sessionId);
  }

  const ctx = {
    logger: { warn: message => state.warnings.push(String(message)) },
    on(name, listener) {
      listeners.push([name, listener]);
      return () => {
        const index = listeners.findIndex(entry => entry[0] === name && entry[1] === listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    workspaces: { created: [] },
    workspaceRegistry: {
      create: async (cwd, title) => {
        const id = `workspace-${cwd.split('/').filter(Boolean).pop() ?? 'root'}`;
        if (!ctx.workspaces.created.includes(id)) ctx.workspaces.created.push(id);
        return { id, path: cwd, title };
      },
      get: id => ({ id }),
      list: () => [],
    },
    agents: {
      get: id => state.agents.get(id),
      list: () => [...state.agents.values()],
    },
    sessions: { flush: async () => true },
    sessionController: {
      create: async ({ workspaceId }) => {
        const sessionId = `session-${state.created.length + 1}`;
        state.created.push({ sessionId, workspaceId });
        ensureAgent(sessionId);
        return { sessionId };
      },
      rename: async request => { state.renames.push(request); return { accepted: true }; },
      fork: async ({ sessionId, atSeq }) => {
        if (!forkSupported) throw new Error('session/fork-unavailable');
        // 会话日志持久化在 state.log：即使 agent 已卸载（模拟重启）也能 fork。
        const events = state.log.get(sessionId);
        if (!events) throw new Error(`session/not-found: ${sessionId}`);
        const boundary = atSeq ?? events.findLast(event => event.type === 'turn/end')?.seq;
        if (boundary === undefined) throw new Error('session/fork-unavailable');
        state.forks++;
        const id = `session-fork-${state.forks}`;
        createAgent(id, { inherited: events.slice(0, boundary + 1) });
        return { sessionId: id };
      },
      prompt: async ({ sessionId, requestId, content, mode, clientTimeZone }, signal) => {
        // 真实 DSH 宿主会直接调用 signal.throwIfAborted()：漏传 signal 必须在这里炸出来
        signal.throwIfAborted();
        const text = content.map(part => part.text ?? '').join('');
        state.prompts.push({ sessionId, requestId, mode, text, clientTimeZone, at: Date.now() });
        const agent = ensureAgent(sessionId);
        if (mode === 'steer' && agent.status === 'running') {
          state.steers.push({ sessionId, text });
          agent.push('user/message', { message: { content: [{ type: 'text', text }] }, source: { kind: 'user', mode: 'steer' } });
          return { accepted: true };
        }
        agent.startTurn(text);
        return { accepted: true };
      },
    },
  };

  return { ctx, state, createAgent };
}
