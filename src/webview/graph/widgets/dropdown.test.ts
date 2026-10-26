// @vitest-environment jsdom
/**
 * The dropdown widget (src/webview/graph/widgets/dropdown.ts) and the repository dropdown's
 * options (getRepoDropdownOptions of src/webview/graph/controlBar/controlBar.ts), merged per
 * REFACTOR-PLAN Appendix B from three legacy full-page-boot tests:
 *
 *  - tests/dropdownKeyboardNav.test.mjs: a real key press fires keydown THEN keyup; the filter's
 *    keyup used to reset the keyboard highlight that keydown had just set, leaving the option
 *    looking highlighted while Enter silently selected nothing.
 *  - tests/dropdownInfoClick.test.mjs: the information icon is an independent action - it must
 *    show the repository's path without selecting the option that contains it.
 *  - tests/repoDropdown.test.mjs: every repository is listed by its short name - never by an
 *    absolute path, which a Windows backend's native-separator paths used to degrade into. A
 *    repository contained within another known repository shows its path relative to the closest
 *    containing repository as the option's tooltip, and a configured name always wins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventOverlay } from '../../common/eventOverlay';
import { formatStr, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { ControlBar, getRepoDropdownOptions } from '../controlBar/controlBar';
import type { GraphContext } from '../context';
import { Dialog } from './dialog';
import { Dropdown } from './dropdown';

/**
 * The widgets on these click paths schedule real jsdom timers (the dropdown's 500 ms
 * double-click window, the dialog's 180 ms delayed removal). A timer that outlives its test
 * fires after the jsdom environment is torn down and surfaces as a post-teardown error under
 * heavy parallel load (OPTIMIZATION-PLAN §12's known-flaky). Every window.setTimeout of a
 * test is captured and whatever is still pending is cleared at the test's end; timing WITHIN
 * a test stays real, so no assertion changes.
 */
let pendingTimers: number[] = [];
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);

beforeEach(() => {
	document.body.textContent = '';
	// jsdom has no layout engine and does not implement scrollIntoView (used when the keyboard
	// highlight moves).
	window.Element.prototype.scrollIntoView = function () { };
	pendingTimers = [];
	vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
		const id = realSetTimeout(handler, timeout, ...args);
		pendingTimers.push(id);
		return id;
	}) as unknown as typeof window.setTimeout);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const id of pendingTimers.splice(0)) realClearTimeout(id);
});

/** A dropdown element appended to the page, with the change/info callbacks recorded. */
function makeDropdown(showInfo: boolean, infoCallback?: (option: { name: string, value: string }) => void) {
	const elem = document.createElement('div');
	elem.className = 'dropdown';
	document.body.appendChild(elem);
	const changed: string[][] = [];
	const dropdown = new Dropdown(elem, showInfo, false, 'Repository', (values) => { changed.push(values); }, infoCallback ?? null);
	return { dropdown: dropdown, elem: elem, changed: changed };
}

const fireKey = (target: Element, type: string, key: string) =>
	target.dispatchEvent(new KeyboardEvent(type, { key: key, bubbles: true, cancelable: true }));

describe('dropdown keyboard navigation', () => {
	it('selects the arrow-key-highlighted option on Enter', () => {
		const { elem, dropdown } = makeDropdown(false);
		dropdown.setOptions([
			{ name: 'a-repo', value: '/ws/a' },
			{ name: 'b-repo', value: '/ws/b' }
		], ['/ws/a']);
		const currentValueElem = elem.querySelector<HTMLElement>('.dropdownCurrentValue')!;
		const filterInput = elem.querySelector<HTMLElement>('.dropdownFilterInput')!;

		// Open the dropdown (mouse click on the current value, as the control bar wires it up)
		currentValueElem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(elem.classList.contains('dropdownOpen')).toBe(true);

		const options = Array.from(elem.querySelectorAll<HTMLElement>('.dropdownOption'));
		expect(options.length).toBe(2);
		const initiallySelected = options.find((option) => option.classList.contains('selected'))!;
		const other = options.find((option) => option !== initiallySelected)!;
		const otherTitle = other.title;

		// Press ArrowDown once: keydown moves the highlight, keyup fires right after (as a browser
		// does for every real key press) and must not silently undo it
		fireKey(filterInput, 'keydown', 'ArrowDown');
		fireKey(filterInput, 'keyup', 'ArrowDown');
		expect(other.classList.contains('highlighted')).toBe(true);

		// Press Enter: the visually-highlighted option should be selected and the dropdown closed
		fireKey(filterInput, 'keydown', 'Enter');
		fireKey(filterInput, 'keyup', 'Enter');

		// Selecting an option re-renders .dropdownOptions' innerHTML, replacing the DOM nodes -
		// re-query rather than reusing the (now detached) references
		const optionsAfter = Array.from(elem.querySelectorAll<HTMLElement>('.dropdownOption'));
		const otherAfter = optionsAfter.find((option) => option.title === otherTitle)!;

		expect(elem.classList.contains('dropdownOpen')).toBe(false);
		expect(otherAfter.classList.contains('selected')).toBe(true);
		expect(optionsAfter.filter((option) => option.classList.contains('selected')).length).toBe(1);
		expect(currentValueElem.title).toBe(otherTitle);
	});
});

describe('dropdown information button', () => {
	it('shows the full repository path without changing the selection', () => {
		const infoShown: Array<{ name: string, value: string }> = [];
		const { elem, dropdown } = makeDropdown(true, (option) => { infoShown.push({ name: option.name, value: option.value }); });
		dropdown.setOptions([
			{ name: 'main', value: '/ws/main' },
			{ name: 'other', value: '/ws/other' }
		], ['/ws/main']);
		const currentValueElem = elem.querySelector<HTMLElement>('.dropdownCurrentValue')!;
		currentValueElem.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		const initialValue = currentValueElem.title;
		const infoButton = elem.querySelector<HTMLElement>('.dropdownOption[data-id="1"] .dropdownOptionInfo')!;
		expect(infoButton).not.toBe(null);
		expect(infoButton.getAttribute('aria-label')).toBe(formatStr(strings.dropdownOptionInfoLabel, 'other'));

		infoButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(elem.classList.contains('dropdownOpen')).toBe(false); // the click closes the dropdown
		expect(currentValueElem.title).toBe(initialValue); // ... without selecting the repository
		expect(infoShown).toEqual([{ name: 'other', value: '/ws/other' }]);
	});

	it('is wired by the control bar to the repository information dialog', () => {
		// The skeleton the extension host renders for the control bar
		for (const id of ['repoDropdown', 'branchDropdown', 'authorDropdown']) {
			const dropdownElem = document.createElement('div');
			dropdownElem.id = id;
			dropdownElem.className = 'dropdown';
			document.body.appendChild(dropdownElem);
		}
		const checkbox = document.createElement('input');
		checkbox.id = 'showRemoteBranchesCheckbox';
		document.body.appendChild(checkbox);
		document.body.appendChild(Object.assign(document.createElement('div'), { id: 'refreshBtn' }));

		const dialog = new Dialog({
			eventOverlay: new EventOverlay(() => { }),
			closeDialogAndContextMenu: () => { },
			findCommitElem: () => null,
			getReferenceInputSpaceSubstitution: () => null
		});
		const ctx = {
			dialog: dialog,
			loader: { loadRepo: () => { }, clearCommits: () => { }, requestLoadRepoInfoAndCommits: () => { }, refresh: () => { }, forgetPullRequestsRequest: () => { } },
			store: { currentRepo: '/ws/main', refreshState: { inProgress: false }, config: { repoDropdownOrder: GG.RepoDropdownOrder.FullPath, initialLoadCommits: 100 } },
			persistence: { saveState: () => { }, saveRepoStateValue: () => { } },
			viewport: { capturePendingViewportAnchor: () => { } }
		};
		const controls = new ControlBar(() => ctx as unknown as GraphContext);
		controls.init();
		controls.repoDropdown.setOptions(getRepoDropdownOptions(<GG.GitRepoSet><unknown>{
			'/ws/main': { name: null, workspaceFolderIndex: 0 },
			'/ws/other': { name: null, workspaceFolderIndex: 0 }
		}, GG.RepoDropdownOrder.FullPath), ['/ws/main']);

		const dropdownElem = document.getElementById('repoDropdown')!;
		dropdownElem.querySelector<HTMLElement>('.dropdownCurrentValue')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		dropdownElem.querySelector<HTMLElement>('.dropdownOption[data-id="1"] .dropdownOptionInfo')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(document.querySelector('.dialog')!.textContent).toMatch(/Path: \/ws\/other/);
	});
});

describe('the repository dropdown display names (getRepoDropdownOptions)', () => {
	/**
	 * The options of a repository set as the user sees them: rendered through the real dropdown
	 * (with information buttons, whose title carries the option's value), keyed by repository
	 * path. The DOM title is what the tooltip shows - the dropdown falls back to the option's
	 * name when the option carries no sub-repository path.
	 */
	const renderedOptions = (repoPaths: { [path: string]: { name: string | null } }) => {
		const repos: { [path: string]: { name: string | null, workspaceFolderIndex: number | null } } = {};
		for (const [path, repo] of Object.entries(repoPaths)) repos[path] = { name: repo.name, workspaceFolderIndex: null };
		const { elem, dropdown } = makeDropdown(true);
		dropdown.setOptions(getRepoDropdownOptions(<GG.GitRepoSet><unknown>repos, GG.RepoDropdownOrder.FullPath), null);
		const options = Array.from(elem.querySelectorAll<HTMLElement>('.dropdownOption')).map((option): { value: string, name: string, hint: string, title: string } => ({
			value: option.querySelector<HTMLElement>('.dropdownOptionInfo')!.title,
			name: option.querySelector('.dropdownOptionHint') !== null ? option.childNodes[0].textContent || '' : option.textContent || '',
			hint: option.querySelector('.dropdownOptionHint') !== null ? option.querySelector<HTMLElement>('.dropdownOptionHint')!.textContent || '' : '',
			title: option.title
		}));
		return new Map(options.map((option) => [option.value, option]));
	};

	it('lists every repository by its short name, sub-repositories with their relative path as tooltip', () => {
		const options = renderedOptions({
			'/ws/proj': { name: null },
			'/ws/proj/vendor/zlib': { name: null },
			'/ws/proj/third_party/googletest': { name: null },
			'/ws/other': { name: null }
		});

		expect(options.get('/ws/proj')!.name).toBe('proj');
		expect(options.get('/ws/proj')!.title).toBe('proj');
		expect(options.get('/ws/proj/vendor/zlib')!.name).toBe('zlib');
		expect(options.get('/ws/proj/vendor/zlib')!.title).toBe('vendor/zlib');
		expect(options.get('/ws/proj/third_party/googletest')!.name).toBe('googletest');
		expect(options.get('/ws/proj/third_party/googletest')!.title).toBe('third_party/googletest');
		expect(options.get('/ws/other')!.name).toBe('other');
		expect(options.get('/ws/other')!.title).toBe('other');
	});

	it('shows a nested sub-repository relative to its immediate parent repository', () => {
		const options = renderedOptions({
			'/ws/proj': { name: null },
			'/ws/proj/vendor/zlib': { name: null },
			'/ws/proj/vendor/zlib/deps/bar': { name: null }
		});

		expect(options.get('/ws/proj/vendor/zlib')!.name).toBe('zlib');
		expect(options.get('/ws/proj/vendor/zlib')!.title).toBe('vendor/zlib');
		expect(options.get('/ws/proj/vendor/zlib/deps/bar')!.name).toBe('bar');
		expect(options.get('/ws/proj/vendor/zlib/deps/bar')!.title).toBe('deps/bar');
	});

	it('resolves the containing repository despite Windows drive letter and directory casing', () => {
		// The engine canonicalises submodule paths (uppercase drive, actual directory casing),
		// while the workspace repository comes from the workspace folder URI
		const options = renderedOptions({
			'c:/Users/Dev/Project': { name: null },
			'C:/Users/Dev/Project/vendor/zlib': { name: null }
		});

		expect(options.get('c:/Users/Dev/Project')!.name).toBe('Project');
		expect(options.get('C:/Users/Dev/Project/vendor/zlib')!.name).toBe('zlib');
		expect(options.get('C:/Users/Dev/Project/vendor/zlib')!.title).toBe('vendor/zlib');
	});

	it('never falls back to showing an absolute path for an ambiguous sub-repository name', () => {
		const options = renderedOptions({
			'/ws/a': { name: null },
			'/ws/a/deps/bar': { name: null },
			'/ws/b': { name: null },
			'/ws/b/deps/bar': { name: null }
		});

		const a = options.get('/ws/a/deps/bar')!, b = options.get('/ws/b/deps/bar')!;
		expect(a.name).toBe('bar');
		expect(b.name).toBe('bar');
		expect(a.title).toBe('deps/bar');
		expect(b.title).toBe('deps/bar');
		// The disambiguating hint identifies the parent, and never shows an absolute path
		expect(a.hint).not.toBe('');
		expect(b.hint).not.toBe('');
		expect(a.name.startsWith('/ws/')).toBe(false);
		expect(b.name.startsWith('/ws/')).toBe(false);
	});

	it('prefers a name configured for the repository', () => {
		const options = renderedOptions({
			'/ws/proj': { name: 'Main Project' },
			'/ws/proj/vendor/zlib': { name: 'Zlib Fork' }
		});

		expect(options.get('/ws/proj')!.name).toBe('Main Project');
		expect(options.get('/ws/proj')!.title).toBe('Main Project');
		expect(options.get('/ws/proj/vendor/zlib')!.name).toBe('Zlib Fork');
		// The tooltip still tells where the sub-repository lives within the parent repository
		expect(options.get('/ws/proj/vendor/zlib')!.title).toBe('vendor/zlib');
	});
});
