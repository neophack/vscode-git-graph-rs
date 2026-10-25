// @vitest-environment jsdom
/**
 * The Reflog Widget (src/webview/graph/widgets/reflogView.ts): the client-side classification of
 * reflog messages (ported from tests/reflogClassification.test.mjs, which bundled the source with
 * esbuild and executed it through `new Function` — banned by REFACTOR-PLAN T2/T3; this is the
 * real module imported directly), and the overlay's lifecycle (ported from the reflog cases of
 * tests/webviewTools.test.mjs): the request it sends, the rows it renders, and that closing it
 * CLEARS the content — the widget hides by sliding up to top:-158px, so leftover content would
 * keep a tall list's lower part visible on screen.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { GraphContext } from '../context';
import { ReflogView, classifyReflogAction } from './reflogView';

/** A context holding only what the Reflog Widget touches: the bridge and the current repository. */
function makeContext() {
	const sent: Array<{ command: string, [key: string]: unknown }> = [];
	const ctx = {
		bridge: { send: (message: { command: string }) => { sent.push(message); } },
		store: { currentRepo: '/repo', config: { dateFormat: { type: 0, iso: false } } }
	};
	return { ctx: ctx as unknown as GraphContext, sent: sent };
}

describe('classifyReflogAction', () => {
	it('colour-codes each reflog message by its leading verb and (sub-action)', () => {
		const cases: ReadonlyArray<[string, string]> = [
			['commit (amend): fix typo', 'reflogEdit'], // an amend, even though the leading verb is "commit"
			['commit (squash): combine changes', 'reflogCombine'],
			['commit (fixup): small correction', 'reflogCombine'],
			['rebase (abort)', 'reflogAbort'], // not reflogFlow
			['reset: moving to HEAD~1', 'reflogAbort'], // the destructive / loses-work case
			['rebase (pick): some commit message', 'reflogFlow'],
			['rebase (start): checkout onto', 'reflogFlow'],
			['branch: Created from HEAD', 'reflogFlow'],
			['merge feature: Fast-forward', 'reflogIntegrate'],
			['pull: Fast-forward', 'reflogIntegrate'],
			['checkout: moving from main to feature', 'reflogIntegrate'],
			['cherry-pick: abc123 some message', 'reflogIntegrate'], // hyphenated verb
			['revert: abc123 some message', 'reflogIntegrate'],
			['commit: plain message', 'reflogDefault'],
			['clone: from origin', 'reflogDefault'] // unrecognised, not throwing
		];
		for (const [message, expected] of cases) {
			expect(classifyReflogAction(message), message).toBe(expected);
		}
	});
});

describe('the Reflog overlay', () => {
	let reflog: ReflogView, sent: Array<{ command: string, [key: string]: unknown }>;

	beforeEach(() => {
		document.body.textContent = '';
		const context = makeContext();
		sent = context.sent;
		reflog = new ReflogView(() => context.ctx);
	});

	/** A minimal reflog page the extension host could have answered with. */
	const reflogResponse = (entries: number[]) => ({
		command: 'reflog',
		ref: 'HEAD',
		entries: entries.map((i) => ({
			hash: 'c' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			abbrevHash: 'c' + String(i).padStart(4, '0'),
			selector: 'HEAD@{' + i + '}',
			date: 1700000000 - i,
			message: i === 0 ? 'checkout: moving from main to feature' : 'commit: message ' + i,
			dangling: false
		})),
		moreAvailable: false,
		error: null
	});

	it('requests the reflog of HEAD when opened', () => {
		reflog.show();
		expect(sent.some((message) => message.command === 'reflog' && message.ref === 'HEAD' && message.repo === '/repo')).toBe(true);
	});

	it('renders the entries as rows, colour-coded by the classification', () => {
		reflog.show();
		reflog.processResponse(<never>reflogResponse([0, 1, 2]));
		const rows = document.querySelectorAll('#reflogContent .reflogRow');
		expect(rows.length).toBe(3);
		expect(rows[0].querySelector('.reflogDot.reflogIntegrate')).not.toBe(null); // checkout
		expect(rows[1].querySelector('.reflogDot.reflogDefault')).not.toBe(null);
	});

	it('ignores a stale response of another repository', () => {
		reflog.show();
		reflog.processResponse(<never>{ ...reflogResponse([0]), repo: '/other-repo' });
		expect(document.querySelectorAll('#reflogContent .reflogRow').length).toBe(0);
	});

	it('close clears the rendered entries, not just the active class', () => {
		reflog.show();
		reflog.processResponse(<never>reflogResponse([0, 1, 2]));
		expect(document.querySelectorAll('#reflogContent .reflogRow').length).toBe(3);

		reflog.close();
		expect(document.getElementById('reflogWidget')!.classList.contains('active')).toBe(false);
		expect(document.getElementById('reflogContent')!.innerHTML).toBe('');
	});
});
