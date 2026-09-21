/**
 * Tests for the complete-automation-test script's empty-directory guard (scripts/automation/
 * full-test.mjs): it must refuse to build a fixture inside a folder that might hold real work,
 * while still allowing a missing/empty directory, a re-run against a fixture it already built,
 * and an explicit --force.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkTargetDir } from '../scripts/automation/full-test.mjs';

const scratch = path.join(os.tmpdir(), 'gg-full-test-guard');

test.beforeEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

test.after(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

test('a missing directory is accepted (it will be created)', () => {
	assert.doesNotThrow(() => checkTargetDir(scratch));
});

test('an empty directory is accepted', () => {
	fs.mkdirSync(scratch, { recursive: true });
	assert.doesNotThrow(() => checkTargetDir(scratch));
});

test('a directory holding only a prior fixture is accepted (re-running reuses it)', () => {
	fs.mkdirSync(path.join(scratch, 'fixture'), { recursive: true });
	fs.mkdirSync(path.join(scratch, 'fixture-remote.git'), { recursive: true });
	assert.doesNotThrow(() => checkTargetDir(scratch));
});

test('a directory holding unrelated content is refused with a reminder', () => {
	fs.mkdirSync(scratch, { recursive: true });
	fs.writeFileSync(path.join(scratch, 'notes.txt'), 'do not touch me');
	assert.throws(() => checkTargetDir(scratch), /not empty/);
});

test('a directory holding unrelated content alongside a fixture is still refused', () => {
	fs.mkdirSync(path.join(scratch, 'fixture'), { recursive: true });
	fs.writeFileSync(path.join(scratch, 'important.txt'), 'real work');
	assert.throws(() => checkTargetDir(scratch), /not empty/);
});

test('--force bypasses the guard even over unrelated content', () => {
	fs.mkdirSync(scratch, { recursive: true });
	fs.writeFileSync(path.join(scratch, 'notes.txt'), 'do not touch me');
	assert.doesNotThrow(() => checkTargetDir(scratch, { force: true }));
});
