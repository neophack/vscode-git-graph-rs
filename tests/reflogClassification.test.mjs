/**
 * src/webview/graph/widgets/reflogView.ts's `classifyReflogAction` colour-codes each Reflog Widget row purely by
 * string-matching the reflog message Git itself produces (no extra `git` call) - the leading
 * action verb, plus any `(sub-action)` in parentheses. This pins the mapping against the actual
 * message shapes `git reflog` produces for the operations users care most about distinguishing
 * at a glance (an amend vs. a destructive reset vs. an ordinary checkout).
 */

import assert from 'node:assert/strict';
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Bundle the real module for node; importing it is side-effect free (the widget is only built when instantiated).
const bundled = esbuild.buildSync({
	entryPoints: [path.join(root, 'src', 'webview', 'graph', 'widgets', 'reflogView.ts')],
	bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18'
}).outputFiles[0].text;
const loaded = { exports: {} };
new Function('module', 'exports', bundled)(loaded, loaded.exports);
const { classifyReflogAction } = loaded.exports;

describe('classifyReflogAction', () => {
	it('classifies an amend as reflogEdit, even though the leading verb is "commit"', () => {
		assert.equal(classifyReflogAction('commit (amend): fix typo'), 'reflogEdit');
	});

	it('classifies a squash as reflogCombine', () => {
		assert.equal(classifyReflogAction('commit (squash): combine changes'), 'reflogCombine');
	});

	it('classifies a fixup as reflogCombine', () => {
		assert.equal(classifyReflogAction('commit (fixup): small correction'), 'reflogCombine');
	});

	it('classifies a rebase abort as reflogAbort, not reflogFlow', () => {
		assert.equal(classifyReflogAction('rebase (abort)'), 'reflogAbort');
	});

	it('classifies a reset as reflogAbort (the destructive/loses-work case)', () => {
		assert.equal(classifyReflogAction('reset: moving to HEAD~1'), 'reflogAbort');
	});

	it('classifies rebase steps and starts as reflogFlow', () => {
		assert.equal(classifyReflogAction('rebase (pick): some commit message'), 'reflogFlow');
		assert.equal(classifyReflogAction('rebase (start): checkout onto'), 'reflogFlow');
	});

	it('classifies a branch operation as reflogFlow', () => {
		assert.equal(classifyReflogAction('branch: Created from HEAD'), 'reflogFlow');
	});

	it('classifies a merge as reflogIntegrate', () => {
		assert.equal(classifyReflogAction('merge feature: Fast-forward'), 'reflogIntegrate');
	});

	it('classifies a pull as reflogIntegrate', () => {
		assert.equal(classifyReflogAction('pull: Fast-forward'), 'reflogIntegrate');
	});

	it('classifies a checkout as reflogIntegrate', () => {
		assert.equal(classifyReflogAction('checkout: moving from main to feature'), 'reflogIntegrate');
	});

	it('classifies a cherry-pick (hyphenated verb) as reflogIntegrate', () => {
		assert.equal(classifyReflogAction('cherry-pick: abc123 some message'), 'reflogIntegrate');
	});

	it('classifies a revert as reflogIntegrate', () => {
		assert.equal(classifyReflogAction('revert: abc123 some message'), 'reflogIntegrate');
	});

	it('classifies a plain commit (no sub-action) as reflogDefault', () => {
		assert.equal(classifyReflogAction('commit: plain message'), 'reflogDefault');
	});

	it('classifies an unrecognised action as reflogDefault, not throwing', () => {
		assert.equal(classifyReflogAction('clone: from origin'), 'reflogDefault');
	});
});
