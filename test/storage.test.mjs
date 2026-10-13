import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson } from '../protocol.js';
import { tempRoot } from './helpers.mjs';

test('atomic JSON retries transient replacement errors while keeping the old file readable', async t => {
  const root = await tempRoot(t);
  const file = path.join(root, 'status.json');
  await atomicJson(file, { state: 'queued' });
  const rename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, 'rename', async (source, destination) => {
    assert.equal(destination, file);
    assert.deepEqual(await readJson(file), { state: 'queued' });
    if (++attempts <= 2) throw Object.assign(new Error('Windows sharing violation'), { code: 'EPERM' });
    return rename(source, destination);
  });
  await atomicJson(file, { state: 'running' });
  assert.equal(attempts, 3);
  assert.deepEqual(await readJson(file), { state: 'running' });
  assert.deepEqual(await fs.readdir(root), ['status.json']);
});

test('atomic JSON rejects permanent replacement errors and cleans its temporary file', async t => {
  const root = await tempRoot(t);
  const file = path.join(root, 'status.json');
  await atomicJson(file, { state: 'queued' });
  let attempts = 0;
  t.mock.method(fs, 'rename', async () => {
    attempts++;
    throw Object.assign(new Error('Invalid replacement'), { code: 'EINVAL' });
  });
  await assert.rejects(atomicJson(file, { state: 'running' }), { code: 'EINVAL' });
  assert.equal(attempts, 1);
  assert.deepEqual(await readJson(file), { state: 'queued' });
  assert.deepEqual(await fs.readdir(root), ['status.json']);
});

test('atomic JSON stops retrying persistent file contention without removing the old state', async t => {
  const root = await tempRoot(t);
  const file = path.join(root, 'status.json');
  await atomicJson(file, { state: 'queued' });
  let attempts = 0;
  t.mock.method(fs, 'rename', async () => {
    attempts++;
    throw Object.assign(new Error('File remains busy'), { code: 'EBUSY' });
  });
  await assert.rejects(atomicJson(file, { state: 'running' }), { code: 'EBUSY' });
  assert.ok(attempts > 1 && attempts <= 10);
  assert.deepEqual(await readJson(file), { state: 'queued' });
  assert.deepEqual(await fs.readdir(root), ['status.json']);
});
