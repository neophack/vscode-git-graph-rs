/**
 * Tests for the Repos dropdown's display names.
 *
 * Every repository is listed by its short name — never by an absolute path, which is what a
 * Windows backend's native-separator paths used to degrade into. A repository contained within
 * another known repository (a submodule or a nested repository) additionally shows its path
 * relative to the closest containing repository as the option's tooltip, and a name configured
 * for the repository always wins over the short name.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

/* Importing the harness installs the 'vscode' stub its out/ modules need, so this import must
 * come after it. */
const { DEFAULT_REPO_STATE } = await import('../out/extensionState.js');

const repoState = (overrides = {}) => ({ ...JSON.parse(JSON.stringify(DEFAULT_REPO_STATE)), ...overrides });

/**
 * Boot the webview with the given repository set and collect the rendered Repos dropdown
 * options as { value, name, hint, title } — exactly what the user sees in the dropdown.
 */
async function dropdownOptions(repoPathsAndStates) {
	const h = await bootView(5, { repos: repoPathsAndStates });
	return Array.from(h.document.querySelectorAll('#repoDropdown .dropdownOption')).map((option) => ({
		value: option.querySelector('.dropdownOptionInfo').title,
		name: option.querySelector('.dropdownOptionHint') !== null ? option.childNodes[0].textContent : option.textContent,
		hint: option.querySelector('.dropdownOptionHint') !== null ? option.querySelector('.dropdownOptionHint').textContent : '',
		title: option.title
	}));
}

const byValue = (options) => new Map(options.map((option) => [option.value, option]));

describe('the Repos dropdown display names', () => {
	it('lists every repository by its short name, sub-repositories with their relative path as tooltip', async () => {
		const options = byValue(await dropdownOptions({
			'/ws/proj': null,
			'/ws/proj/vendor/zlib': null,
			'/ws/proj/third_party/googletest': null,
			'/ws/other': null
		}));

		assert.equal(options.get('/ws/proj').name, 'proj');
		assert.equal(options.get('/ws/proj').title, 'proj');
		assert.equal(options.get('/ws/proj/vendor/zlib').name, 'zlib');
		assert.equal(options.get('/ws/proj/vendor/zlib').title, 'vendor/zlib');
		assert.equal(options.get('/ws/proj/third_party/googletest').name, 'googletest');
		assert.equal(options.get('/ws/proj/third_party/googletest').title, 'third_party/googletest');
		assert.equal(options.get('/ws/other').name, 'other');
		assert.equal(options.get('/ws/other').title, 'other');
	});

	it('shows a nested sub-repository relative to its immediate parent repository', async () => {
		const options = byValue(await dropdownOptions({
			'/ws/proj': null,
			'/ws/proj/vendor/zlib': null,
			'/ws/proj/vendor/zlib/deps/bar': null
		}));

		assert.equal(options.get('/ws/proj/vendor/zlib').name, 'zlib');
		assert.equal(options.get('/ws/proj/vendor/zlib').title, 'vendor/zlib');
		assert.equal(options.get('/ws/proj/vendor/zlib/deps/bar').name, 'bar');
		assert.equal(options.get('/ws/proj/vendor/zlib/deps/bar').title, 'deps/bar');
	});

	it('resolves the containing repository despite Windows drive letter and directory casing', async () => {
		// The engine canonicalises submodule paths (uppercase drive, actual directory casing),
		// while the workspace repository comes from the workspace folder URI
		const options = byValue(await dropdownOptions({
			'c:/Users/Dev/Project': null,
			'C:/Users/Dev/Project/vendor/zlib': null
		}));

		assert.equal(options.get('c:/Users/Dev/Project').name, 'Project');
		assert.equal(options.get('C:/Users/Dev/Project/vendor/zlib').name, 'zlib');
		assert.equal(options.get('C:/Users/Dev/Project/vendor/zlib').title, 'vendor/zlib');
	});

	it('never falls back to showing an absolute path for an ambiguous sub-repository name', async () => {
		const options = byValue(await dropdownOptions({
			'/ws/a': null,
			'/ws/a/deps/bar': null,
			'/ws/b': null,
			'/ws/b/deps/bar': null
		}));

		const a = options.get('/ws/a/deps/bar'), b = options.get('/ws/b/deps/bar');
		assert.equal(a.name, 'bar');
		assert.equal(b.name, 'bar');
		assert.equal(a.title, 'deps/bar');
		assert.equal(b.title, 'deps/bar');
		// The disambiguating hint identifies the parent, and never shows an absolute path
		assert.notEqual(a.hint, '');
		assert.notEqual(b.hint, '');
		assert.ok(!a.name.startsWith('/ws/'));
		assert.ok(!b.name.startsWith('/ws/'));
	});

	it('prefers a name configured for the repository', async () => {
		const options = byValue(await dropdownOptions({
			'/ws/proj': repoState({ name: 'Main Project' }),
			'/ws/proj/vendor/zlib': repoState({ name: 'Zlib Fork' })
		}));

		assert.equal(options.get('/ws/proj').name, 'Main Project');
		assert.equal(options.get('/ws/proj').title, 'Main Project');
		assert.equal(options.get('/ws/proj/vendor/zlib').name, 'Zlib Fork');
		// The tooltip still tells where the sub-repository lives within the parent repository
		assert.equal(options.get('/ws/proj/vendor/zlib').title, 'vendor/zlib');
	});
});
