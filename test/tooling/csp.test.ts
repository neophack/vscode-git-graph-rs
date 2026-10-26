/**
 * The webview Content-Security-Policy contract on the GENERATED page HTML (OPTIMIZATION-PLAN
 * V3/S6): the page is produced at runtime by src/extension/graphView/html.ts, so the two build
 * variants are exercised by rendering it the way each build does - the default/production build
 * ships no automation shim (resources/automation/shim.js is absent from the VSIX), and the
 * automation build carries one.
 *
 * Pinned here:
 *  - default-src stays 'none' in both builds;
 *  - production script-src is nonce + cspSource based: no 'unsafe-inline', no 'unsafe-eval';
 *  - the automation build's ONLY delta is 'unsafe-eval' in script-src (the shim compiles
 *    expressions at runtime, a deliberate, documented opt-in - html.ts's render comment);
 *  - 'unsafe-eval' never appears in style-src;
 *  - every script tag carries the nonce.
 *
 * Deliberate deviation from the plan text ("no unsafe-* in the production HTML"): style-src
 * KEEPS 'unsafe-inline' in both builds. The page carries an inline <style> (the graph theme's
 * colour variables) and style="" attributes (display:none rows), which CSP blocks unless
 * style-src allows inline styles; VS Code's own webview sample CSP does the same. What the
 * security posture needs - no inline/eval code execution - is exactly the script-src contract
 * above, and the presence assertions here catch an accidental weakening as well as a
 * regression into eval.
 *
 * html.ts caches the shim read and the cache-buster at module level (one session = one
 * variant), so each render re-imports the module under vi.resetModules to model the other
 * build.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Uri } from 'vscode';
import { afterAll, describe, expect, it, vi } from 'vitest';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-csp-'));

/** A fake extension directory; `withShim` decides which build variant it models. */
function extensionDir(withShim: boolean): string {
	const dir = path.join(tempRoot, withShim ? 'automation' : 'production');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
	if (withShim) {
		fs.mkdirSync(path.join(dir, 'resources', 'automation'), { recursive: true });
		// The real shim compiles recorded user expressions with `eval`; any eval-using script
		// stands in for the presence check - only its existence changes the CSP.
		fs.writeFileSync(path.join(dir, 'resources', 'automation', 'shim.js'), "eval('1 + 1');\n");
	}
	return dir;
}

/** A fresh html.ts module instance rendering as one build variant (see the module note above). */
async function renderHtml(withShim: boolean): Promise<string> {
	vi.resetModules();
	const { renderGraphViewHtml } = await import('../../src/extension/graphView/html');
	const inputs = {
		extensionPath: extensionDir(withShim),
		cspSource: 'https://*.vscode-cdn.net',
		mediaUri: (file: string): Uri => ({ toString: () => 'vscode-webview://csp-test/media/' + file }) as unknown as Uri,
		config: {
			stickyHeader: true,
			graph: { colours: ['#0085d9'] }
		},
		avatarStorageAvailable: false,
		lastActiveRepo: null,
		loadViewTo: null,
		repos: { '/repo': { name: null, workspaceFolderIndex: 0 } },
		refreshIds: { loadRepoInfo: 1, loadCommits: 2, loadConfig: 3 },
		restoredSnapshot: null,
		globalState: {},
		workspaceState: {},
		gitCliAvailable: true,
		logger: { logError: () => undefined }
	} as unknown as Parameters<typeof renderGraphViewHtml>[0];
	return renderGraphViewHtml(inputs);
}

afterAll(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** The CSP meta content of a rendered page, split into `directive: value` entries. */
function cspOf(html: string): { [directive: string]: string } {
	const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
	expect(meta, 'the page must carry a CSP meta tag').not.toBeNull();
	const directives: { [directive: string]: string } = {};
	for (const entry of meta![1].split(';')) {
		const trimmed = entry.trim();
		if (trimmed === '') continue;
		const space = trimmed.indexOf(' ');
		directives[space === -1 ? trimmed : trimmed.slice(0, space)] = space === -1 ? '' : trimmed.slice(space + 1);
	}
	return directives;
}

/** The nonce-carrying script tags of a rendered page (the value inside 'nonce-...'). */
function nonces(html: string): string[] {
	return [...html.matchAll(/nonce="([A-Za-z0-9]+)"/g)].map((match) => match[1]!);
}

describe('the generated webview CSP (both build variants)', () => {
	it('the production build: script-src is nonce + cspSource, with no unsafe-inline and no unsafe-eval', async () => {
		const html = await renderHtml(false);
		const csp = cspOf(html);

		expect(csp['default-src']).toBe("'none'");
		expect(csp['script-src']).toBeDefined();
		expect(csp['script-src']).toContain("'nonce-");
		expect(csp['script-src']).toContain('https://*.vscode-cdn.net');
		expect(csp['script-src']).not.toContain('unsafe-inline');
		expect(csp['script-src']).not.toContain('unsafe-eval');

		// The one sanctioned inline style allowance (see the module comment): the theme's
		// inline <style> block and the style="" attributes. It must never become an eval hole.
		expect(csp['style-src']).toContain('unsafe-inline');
		expect(csp['style-src']).not.toContain('unsafe-eval');

		// No script runs without the nonce.
		expect(html.match(/<script(?![^>]*nonce=)/g)).toBeNull();
	});

	it("the automation build: the shim's runtime eval is the ONLY delta - 'unsafe-eval' in script-src", async () => {
		const production = cspOf(await renderHtml(false));
		const automationHtml = await renderHtml(true);
		const automation = cspOf(automationHtml);

		expect(automation['default-src']).toBe("'none'");
		expect(automation['script-src']).toContain("'unsafe-eval'");
		expect(automation['script-src']).toContain("'nonce-");
		expect(automation['script-src']).not.toContain('unsafe-inline');
		expect(automation['style-src']).toBe(production['style-src']);

		// Exactly one delta: removing the declared opt-in reproduces the production policy (the
		// per-render nonce differs between the two renders, so it is normalised away).
		const normalise = (source: string) => source.replace(/'nonce-[A-Za-z0-9]+'/, "'nonce-<render>'");
		expect(normalise(automation['script-src']).replace(/\s*'unsafe-eval'/, '')).toBe(normalise(production['script-src']));

		// The shim itself is inlined under the nonce like every other script.
		expect(/<script nonce="[A-Za-z0-9]+">eval\('1 \+ 1'\);\s*<\/script>/.test(automationHtml)).toBe(true);
		expect(new Set(nonces(automationHtml)).size).toBe(1);
	});

	it('the media URIs are cache-busted but the cache-buster leaks nothing into the CSP', async () => {
		const html = await renderHtml(false);
		expect(html).toMatch(/out\.min\.js\?v=9\.9\.9\+\d+/);
		expect(html).toMatch(/out\.min\.css\?v=9\.9\.9\+\d+/);
		const csp = cspOf(html);
		for (const directive of Object.keys(csp)) {
			expect(csp[directive]).not.toContain('9.9.9');
		}
	});
});
