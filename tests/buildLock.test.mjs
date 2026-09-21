/**
 * Tests for the build lock (scripts/build-lock.mjs): a second build waits while one holds the
 * lock, a release only frees the lock its own run took, and a lock left behind by a killed
 * run (whose process no longer exists) is stolen instead of blocking forever. All exercised
 * against a sandbox lock directory so the real machine's lock is never touched.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(rootDir, 'scripts', 'build-lock.mjs');
const sandboxLockDir = path.join(os.tmpdir(), 'gg-build-lock-test', 'lock');

function runLock(command, token, { maxWaitMs } = {}) {
	const env = { ...process.env, GGR_BUILD_LOCK_DIR: sandboxLockDir };
	if (maxWaitMs !== undefined) env.GGR_LOCK_MAX_WAIT_MS = String(maxWaitMs);
	return spawnSync(process.execPath, [script, command, token], { env, encoding: 'utf8' });
}

/** A pid that has exited for sure (a child made just to die, given a moment to be reaped). */
function deadPid() {
	const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
	const pid = child.pid;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
	return pid;
}

test.beforeEach(() => {
	fs.rmSync(path.dirname(sandboxLockDir), { recursive: true, force: true });
	fs.mkdirSync(path.dirname(sandboxLockDir), { recursive: true });
});

test.after(() => {
	fs.rmSync(path.dirname(sandboxLockDir), { recursive: true, force: true });
});

test('the lock is exclusive: a second holder times out while the first keeps it', () => {
	assert.equal(runLock('hold', 'run-a').status, 0);
	const denied = runLock('hold', 'run-b', { maxWaitMs: 1500 });
	assert.notEqual(denied.status, 0);
	assert.match(denied.stderr, /Timed out waiting for the build lock/);
});

test('a release only frees the lock its own run took', () => {
	assert.equal(runLock('hold', 'run-a').status, 0);
	// A superseded run (its build failed, the lock was stolen and re-taken) must not free it.
	assert.equal(runLock('release', 'stale-token').status, 0);
	assert.notEqual(runLock('hold', 'run-b', { maxWaitMs: 500 }).status, 0);
	// The rightful owner still can.
	assert.equal(runLock('release', 'run-a').status, 0);
	assert.equal(runLock('hold', 'run-b').status, 0);
	assert.equal(runLock('release', 'run-b').status, 0);
});

test('a lock whose holding process died is stolen instead of blocking', () => {
	assert.equal(runLock('hold', 'run-a').status, 0);
	fs.writeFileSync(path.join(sandboxLockDir, 'owner'), `${deadPid()} run-a`);
	// No wait: the dead owner's lock is taken over immediately.
	assert.equal(runLock('hold', 'run-b', { maxWaitMs: 500 }).status, 0);
	assert.equal(runLock('release', 'run-b').status, 0);
});
