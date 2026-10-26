/**
 * The accessibility gate (OPTIMIZATION-PLAN F5): axe-core runs against the REAL rendered webview
 * DOM - the compiled bundle booted in jsdom (test/support/webviewHost.ts, like the journey
 * tests; `npm run build:dist` must have run first) - failing on serious/critical violations.
 *
 * Three passes cover the surfaces F5 owns: the commit table (the view's primary data grid), the
 * open context menu, and an open modal dialog. The plan's full form runs axe inside P3's
 * Chromium page; this wave's gate runs in jsdom, where layout-dependent checks (colour contrast)
 * report "incomplete" instead of failing - those stay with the browser-based run rather than
 * being skipped silently here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, it, vi } from 'vitest';
import { bootView, rootDir, type BootedView } from '../support/webviewHost';

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

type AxeViolation = { id: string, impact: string | null, nodes: { target: string[] }[] };

const axeSource = fs.readFileSync(path.join(rootDir, 'node_modules', 'axe-core', 'axe.js'), 'utf8');

let h!: BootedView;

/** Run axe over one selector's subtree and keep its serious/critical violations. */
async function seriousCriticalViolations(include: string): Promise<AxeViolation[]> {
	const pageShellRules = { 'document-title': { enabled: false }, 'html-has-lang': { enabled: false }, 'landmark-one-main': { enabled: false }, 'region': { enabled: false }, 'page-has-heading-one': { enabled: false } };
	const results = await (h.window as any).axe.run(h.document, {
		include: [[include]],
		resultTypes: ['violations'],
		// The page-shell rules are out of this gate's scope: the extension host renders the real
		// page with `<html lang="en">` and `<title>Git Graph</title>` (src/extension/graphView/
		// html.ts), which the test harness's minimal skeleton omits - the flag would only ever
		// describe the harness, not the product. They stay in scope for a whole-page (Chromium) run.
		rules: pageShellRules
	});
	return (results.violations as AxeViolation[]).filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
}

function assertClean(violations: AxeViolation[], scope: string) {
	assert.equal(
		violations.length, 0,
		scope + ' has serious/critical axe violations:\n'
		+ violations.map((v) => v.id + ' (' + v.impact + '): ' + v.nodes.slice(0, 5).map((n) => n.target.join(' ')).join('; ')).join('\n')
	);
}

describe('the webview accessibility gate (axe-core)', () => {
	beforeAll(async () => {
		h = await bootView(6);
		h.window.eval(axeSource);
		assert.equal(typeof (h.window as any).axe.run, 'function', 'axe-core evaluated into the webview window');
	});

	it('the commit table renders without serious/critical violations', async () => {
		assertClean(await seriousCriticalViolations('#commitTable'), 'the commit table');
	});

	it('the open context menu renders without serious/critical violations', async () => {
		const row = h.rows().find((r) => r.dataset.id === '1')!;
		row.focus();
		row.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'F10', bubbles: true, cancelable: true, shiftKey: true }));
		const menu = h.document.querySelector('.contextMenu');
		assert.ok(menu !== null, 'the context menu opened');

		assertClean(await seriousCriticalViolations('.contextMenu'), 'the context menu');
	});

	it('the open dialog renders without serious/critical violations', async () => {
		// Close the context menu from the pass above, then open the Edit Message dialog the way
		// the user does: from the row's context menu, through its body-fetch request/response
		h.document.activeElement!.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		assert.equal(h.document.querySelector('.contextMenu'), null);

		const sent: any[] = [];
		const originalPostMessage = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message: any) => {
			sent.push(message);
			return originalPostMessage.call(h.window.VSCODE_API, message);
		};
		const hash = 'c0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		const cell = h.document.querySelector(`#commitTable tr.commit[data-hash="${hash}"] .description`)!;
		cell.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		const item = Array.from(h.document.querySelectorAll<HTMLElement>('.contextMenuItem'))
			.find((li) => li.textContent!.includes('Edit Message'));
		assert.ok(item !== undefined, 'the commit context menu offers "Edit Message"');
		item.click();

		const deadline = Date.now() + 10000;
		for (;;) {
			const request = sent.filter((m) => m.command === 'commitBodies').at(-1);
			if (request !== undefined) {
				h.dispatch({ command: 'commitBodies', bodies: { [hash]: 'commit 0\n\nthe body' }, requestId: request.requestId });
				break;
			}
			if (Date.now() > deadline) throw new Error('the dialog never fetched the body');
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const deadline2 = Date.now() + 10000;
		for (;;) {
			if (h.document.querySelector('.dialog:not(.closing)') !== null) break;
			if (Date.now() > deadline2) throw new Error('the dialog never opened');
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		assertClean(await seriousCriticalViolations('.dialog'), 'the dialog');
	});
});
