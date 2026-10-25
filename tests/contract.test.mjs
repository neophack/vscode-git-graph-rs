/**
 * Static contract tests: the pieces that only meet at runtime — here, the contributed icon set.
 *
 * The other lists this file used to hold against each other are compiler- or test-guaranteed
 * since task 4.1/4.2/4.6: the webview request protocol is guaranteed by the compile-time
 * assertions of src/shared/protocol/graphView.ts (every Request* command equals RequestCommand,
 * and the exhaustive handler table of src/extension/graphView/handlers/index.ts satisfies it),
 * and the contributed commands and menus are compared bidirectionally against package.json by
 * src/extension/commands/registry.test.ts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

/* ---------- The icon set ---------- */

describe('the icon set', () => {
	function iconPathsIn(source) {
		const paths = new Set();
		for (const match of source.matchAll(/resources[\\/][A-Za-z0-9._\\/-]+\.(?:svg|png)/g)) {
			paths.add(match[0].replace(/\\/g, '/'));
		}
		return paths;
	}

	it('every icon referenced by the manifest and the sources exists', () => {
		const pkg = read('package.json');
		// The icon-referencing sources live in the split tree now (task 3.6/6.1): the panel
		// HTML, the status bar item and the comparison view controller. Scan the whole
		// extension tree so future moves cannot silently drop a file from this check.
		const extensionSources = [];
		const walkSources = (dir) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walkSources(full);
				else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) extensionSources.push(fs.readFileSync(full, 'utf8'));
			}
		};
		walkSources(path.join(root, 'src', 'extension'));
		const sources = extensionSources.join('\n');

		const referenced = new Set([...iconPathsIn(pkg), ...iconPathsIn(sources)]);

		// The sources pass bare icon names to getResourcesUri(), which joins them onto the
		// resources directory — collect those too.
		for (const match of sources.matchAll(/'([A-Za-z0-9._-]+\.(?:svg|png))'/g)) {
			if (match[1].startsWith('git-graph-rs-')) referenced.add(`resources/${match[1]}`);
		}

		assert.ok(referenced.size >= 5, `expected the icon references to be found, got ${[...referenced]}`);
		const missing = [...referenced].filter((icon) => !fs.existsSync(path.join(root, icon)));
		assert.deepEqual(missing.sort(), [], 'these icons are referenced but do not exist');
	});

	it('derives the raster icons from the icon masters', () => {
		const sources = ['rust-crab.svg', path.join('upstream', 'icon.png')].map((name) =>
			fs.statSync(path.join(root, 'resources', name))
		);
		const png = fs.statSync(path.join(root, 'resources', 'icon.png'));
		for (const source of sources) {
			assert.ok(
				png.mtimeMs >= source.mtimeMs - 1000,
				`icon.png is older than ${path.basename(source.path ?? '')} — run node scripts/generate-icons.mjs`
			);
		}
	});
});
