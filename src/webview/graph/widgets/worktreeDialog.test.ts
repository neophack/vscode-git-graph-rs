// @vitest-environment jsdom
/**
 * The Worktree Widget (src/webview/graph/widgets/worktreeDialog.ts), ported from the worktree
 * cases of tests/webviewTools.test.mjs: the overlay the Settings Widget's Repository column
 * opens (and the worktreeList request it sends), that closing it CLEARS the content (the widget
 * hides by sliding up to top:-158px, so leftover content would stay visible on screen), and the
 * tooltip wiring of the prunable badge and the remove button - both must pass their own classes
 * through the tooltip's className parameter, because a separate class attribute would win over
 * the tooltip's and the parser would drop the latter, silently disabling the tooltip (as it did
 * for the Statistics heatmap cells before they were fixed).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { GraphContext } from '../context';
import { WorktreeDialog } from './worktreeDialog';

/** A context holding only what the Worktree Widget touches. */
function makeContext() {
	const sent: Array<{ command: string, [key: string]: unknown }> = [];
	const ctx = {
		bridge: { send: (message: { command: string }) => { sent.push(message); } },
		store: { currentRepo: '/repo' }
	};
	return { ctx: ctx as unknown as GraphContext, sent: sent };
}

beforeEach(() => {
	document.body.textContent = '';
});

describe('the Worktrees overlay', () => {
	it('requests the worktree list when opened, and renders a loading state', () => {
		const context = makeContext();
		const worktree = new WorktreeDialog(() => context.ctx);
		worktree.show();

		expect(document.getElementById('worktreeWidget')!.classList.contains('active')).toBe(true);
		expect(context.sent.some((message) => message.command === 'worktreeList' && message.repo === '/repo')).toBe(true);
		expect(document.getElementById('worktreeContent')!.innerHTML).not.toBe('');
	});

	it('close clears the content, not just the active class', () => {
		const context = makeContext();
		const worktree = new WorktreeDialog(() => context.ctx);
		worktree.show();
		const content = document.getElementById('worktreeContent')!;
		expect(content.innerHTML).not.toBe('');

		worktree.close();
		expect(document.getElementById('worktreeWidget')!.classList.contains('active')).toBe(false);
		expect(content.innerHTML).toBe('');
	});

	it('keeps the prunable badge and remove button tooltips on the single class attribute', () => {
		const context = makeContext();
		const worktree = new WorktreeDialog(() => context.ctx);
		worktree.show();
		worktree.processListResponse(<never>{
			command: 'worktreeList',
			worktrees: [
				{ path: '/repo', hash: 'c0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', branch: 'main', detached: false, locked: false, prunable: false, isMain: true },
				{ path: '/repo-wt', hash: 'c0001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', branch: 'feature', detached: false, locked: true, prunable: true, isMain: false }
			]
		});

		for (const selector of ['.worktreeBadgePrunable', '.worktreeRemoveBtn']) {
			const elem = document.querySelector(selector);
			expect(elem, selector + ' rendered').not.toBe(null);
			expect(elem!.className, selector + ' keeps the tooltip hook on the single class attribute').toMatch(/(^| )gg-helpTooltip( |$)/);
			expect(elem!.getAttribute('data-tooltip'), selector + ' has tooltip text').not.toBe('');
		}
	});
});
