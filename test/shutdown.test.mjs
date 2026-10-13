import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startBridge } from '../worker.js';
import { submitTask, readJson, isTerminal, repairJob } from '../protocol.js';
import { makeFake, tempRoot, until, pause } from './helpers.mjs';

function deferred() {
  let finish, settled = false;
  const promise = new Promise(done => { finish = done; });
  return { promise, get settled() { return settled; }, resolve() { settled = true; finish(); } };
}

const waitForGate = gate => until(() => Promise.resolve(gate.settled), Boolean);

const task = (root, id) => ({ id, cwd: root, goal: 'shutdown regression', plan: ['finish'], acceptance: ['deliver'], maxSteps: 10, timeoutSeconds: 30, wrapUpSteps: 0, wrapUpSeconds: 0 });
const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function waitForFinalJournal(root, id, fake) {
  if (!fake.state.created.length) return;
  const status = await until(() => readJson(path.join(root, 'jobs', id, 'status.json'), null), value => value && (isTerminal(value.state) || value.state === 'plugin_unloaded'));
  await until(async () => {
    const lines = (await fs.readFile(path.join(root, 'jobs', id, 'journal.ndjson'), 'utf8')).trim().split('\n');
    return lines.map(line => JSON.parse(line)).some(row => row.k === 'state' && row.state === status.state);
  }, Boolean);
  await pause(0);
}

test('stop waits for an in-flight final status commit before releasing the worker lock', async t => {
  const root = await tempRoot(t, 'dsh-shutdown-finalize-');
  const id = 'finalize';
  const file = path.join(root, 'jobs', id, 'status.json');
  const entered = deferred(), release = deferred(), committed = deferred();
  const rename = fs.rename;
  let stopReturned = false;
  let commitAfterStop = false;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === file && (await readJson(source)).state === 'completed') {
      entered.resolve();
      await release.promise;
      await rename(source, destination);
      commitAfterStop = stopReturned;
      committed.resolve();
      return;
    }
    return rename(source, destination);
  });
  const fake = makeFake();
  const stop = await startBridge(fake.ctx, root, 20);
  let stopping;
  let prematurelyReturned, lockHeld;
  try {
    await submitTask(root, task(root, id));
    await waitForGate(entered);
    stopping = stop().then(() => { stopReturned = true; });
    await Promise.race([stopping, pause(100)]);
    prematurelyReturned = stopReturned;
    lockHeld = await exists(path.join(root, 'worker.lock'));
    release.resolve();
    await waitForGate(committed);
    await stopping;
  } finally {
    release.resolve();
    await (stopping ?? stop());
    await waitForFinalJournal(root, id, fake);
  }
  assert.equal(prematurelyReturned, false, 'stop must wait for the blocked final status write');
  assert.equal(lockHeld, true, 'the old worker must retain its lock until its final write finishes');
  assert.equal(commitAfterStop, false, 'the old worker must not write after stop returns');
  assert.equal(await exists(path.join(root, 'worker.lock')), false);
});

test('a stopped scan does not create a session or submit a prompt after inbox inspection resumes', async t => {
  const root = await tempRoot(t, 'dsh-shutdown-scan-');
  const id = 'scanning';
  const input = path.join(root, 'inbox', id + '.json');
  const entered = deferred(), release = deferred();
  const fake = makeFake();
  const stop = await startBridge(fake.ctx, root, 20);
  const lstat = fs.lstat;
  let gated = false;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (file === input && !gated) {
      gated = true;
      entered.resolve();
      await release.promise;
    }
    return lstat(file, ...args);
  });
  let stopping, stopReturned = false, prematurelyReturned;
  try {
    await submitTask(root, task(root, id));
    await waitForGate(entered);
    stopping = stop().then(() => { stopReturned = true; });
    await Promise.race([stopping, pause(100)]);
    prematurelyReturned = stopReturned;
    release.resolve();
    await stopping;
  } finally {
    release.resolve();
    await (stopping ?? stop());
    // The old implementation can start the task after stopping. Drain it before
    // tempRoot's cleanup even when the regression assertions will fail.
    await pause(50);
    await waitForFinalJournal(root, id, fake);
  }
  assert.equal(prematurelyReturned, false, 'stop must wait for an in-flight scan');
  assert.equal(fake.state.created.length, 0, 'a stopped scan must not create a session');
  assert.equal(fake.state.prompts.length, 0, 'a stopped scan must not prompt the model');
  assert.equal(await exists(path.join(root, 'worker.lock')), false);
});

test('stop preserves an admitted queued job for restart and an old stop cannot remove the new lock', async t => {
  const root = await tempRoot(t, 'dsh-shutdown-admission-');
  const id = 'admitted';
  const input = path.join(root, 'inbox', id + '.json');
  const destination = path.join(root, 'jobs', id, 'task.json');
  const entered = deferred(), release = deferred(), execution = deferred(), finish = deferred();
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    await rename(source, target);
    if (source === input && target === destination) {
      entered.resolve();
      await release.promise;
    }
  });
  const firstFake = makeFake();
  const oldStop = await startBridge(firstFake.ctx, root, 20);
  let stopping, newStop, secondFake;
  let queued, lockBeforeOldStop, lockAfterOldStop, completed;
  try {
    await submitTask(root, task(root, id));
    await waitForGate(entered);
    stopping = oldStop();
    await Promise.race([stopping, pause(100)]);
    release.resolve();
    await stopping;
    queued = await until(() => readJson(path.join(root, 'jobs', id, 'status.json'), null), value => value !== null);
    assert.equal(queued.state, 'queued', 'admission interrupted by shutdown must remain queued');
    assert.equal(firstFake.state.prompts.length, 0, 'shutdown must not start the admitted job');
    secondFake = makeFake({ script: async ({ push }) => {
      push('step/start', { turn: 1, step: 1 });
      execution.resolve();
      await finish.promise;
      push('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } });
      push('step/end', { turn: 1, step: 1 });
    } });
    newStop = await startBridge(secondFake.ctx, root, 20);
    await waitForGate(execution);
    lockBeforeOldStop = await fs.readFile(path.join(root, 'worker.lock'), 'utf8');
    await oldStop();
    lockAfterOldStop = await fs.readFile(path.join(root, 'worker.lock'), 'utf8');
    finish.resolve();
    completed = await until(() => readJson(path.join(root, 'jobs', id, 'status.json')), value => value.state === 'completed');
  } finally {
    release.resolve();
    finish.resolve();
    await (stopping ?? oldStop());
    if (newStop) await newStop();
    await waitForFinalJournal(root, id, firstFake);
    if (secondFake) await waitForFinalJournal(root, id, secondFake);
  }
  assert.equal(lockAfterOldStop, lockBeforeOldStop, 'a completed old stop must not remove or replace a new worker lock');
  assert.equal(completed.state, 'completed');
  assert.equal(secondFake.state.prompts.length, 1, 'a dependency-free queued job must execute exactly once after restart');
});

test('stopping a running task leaves an interrupted state that can be repaired after restart', async t => {
  const root = await tempRoot(t, 'dsh-shutdown-interrupted-');
  const id = 'interrupted';
  const entered = deferred();
  const fake = makeFake({ script: async ({ push, sleep, stopRequested }) => {
    push('step/start', { turn: 1, step: 1 });
    entered.resolve();
    while (!stopRequested()) await sleep(10);
  } });
  const stop = await startBridge(fake.ctx, root, 20);
  let restartedStop, restartedFake, interrupted, repaired;
  try {
    await submitTask(root, task(root, id));
    await waitForGate(entered);
    await stop();
    interrupted = await readJson(path.join(root, 'jobs', id, 'status.json'));
    assert.equal(interrupted.state, 'interrupted');
    assert.equal(interrupted.stoppedBy, 'plugin_unloaded');
    assert.equal(isTerminal(interrupted.state), true);
    await repairJob(root, id, 'Continue after the plugin restarts.');
    restartedFake = makeFake();
    restartedStop = await startBridge(restartedFake.ctx, root, 20);
    repaired = await until(() => readJson(path.join(root, 'jobs', id, 'status.json')), value => value.state === 'completed' && value.attempt === 2);
  } finally {
    await stop();
    if (restartedStop) await restartedStop();
    await waitForFinalJournal(root, id, fake);
    if (restartedFake) await waitForFinalJournal(root, id, restartedFake);
  }
  assert.equal(repaired.state, 'completed');
  assert.equal(repaired.stoppedBy, null);
  assert.equal(restartedFake.state.prompts.length, 1);
});

test('stop waits for monitor progress I/O and preserves finished progress after the delayed write', async t => {
  const root = await tempRoot(t, 'dsh-shutdown-progress-');
  const id = 'progress';
  const file = path.join(root, 'jobs', id, 'progress.json');
  const entered = deferred(), release = deferred(), finished = deferred();
  const rename = fs.rename;
  let gated = false, stopReturned = false, monitorCommitAfterStop = false;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === file) {
      const value = await readJson(source);
      if (!gated && value.state === 'running') {
        gated = true;
        entered.resolve();
        await release.promise;
        await rename(source, destination);
        monitorCommitAfterStop = stopReturned;
        return;
      }
      await rename(source, destination);
      if (value.phase === 'finished') finished.resolve();
      return;
    }
    return rename(source, destination);
  });
  const fake = makeFake({ script: async ({ push, sleep, stopRequested }) => {
    push('step/start', { turn: 1, step: 1 });
    while (!stopRequested()) await sleep(10);
  } });
  const stop = await startBridge(fake.ctx, root, 20);
  let stopping, prematurelyReturned, lockHeld, progress;
  try {
    await submitTask(root, task(root, id));
    await waitForGate(entered);
    stopping = stop().then(() => { stopReturned = true; });
    // A serialized terminal write will also wait for this gate. Release it
    // independently instead of requiring finalization to overtake the monitor.
    await Promise.race([finished.promise, pause(100)]);
    prematurelyReturned = stopReturned;
    lockHeld = await exists(path.join(root, 'worker.lock'));
    release.resolve();
    await stopping;
    progress = await readJson(file);
  } finally {
    release.resolve();
    await (stopping ?? stop());
    await waitForFinalJournal(root, id, fake);
  }
  assert.equal(prematurelyReturned, false, 'stop must wait for the blocked monitor write');
  assert.equal(lockHeld, true, 'the worker lock must cover pending monitor I/O');
  assert.equal(monitorCommitAfterStop, false, 'monitor I/O must finish before stop returns');
  assert.equal(progress.phase, 'finished', 'the old running monitor snapshot must not overwrite final progress');
  assert.equal(progress.state, 'interrupted');
});
