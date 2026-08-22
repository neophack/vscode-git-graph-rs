/**
 * Static contract tests: the pieces that only meet at runtime.
 *
 * The webview protocol, the command registrations and the contributed icons are three lists that
 * no compiler reconciles — a message type without a handler, a contributed command nothing
 * registers, or an icon path that points at nothing, all fail silently until a user hits them.
 * These tests hold the lists against each other.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

/* ---------- The webview request protocol ---------- */

describe('the webview message protocol', () => {
	/**
	 * Every `Request*` interface in types.ts, paired with the command literal it declares. The
	 * responses (`Response*`) go the other way and are produced by the extension, so they are not
	 * expected to appear in the receiving switch.
	 */
	function requestCommands() {
		const types = read('src', 'types.ts');
		const blocks = types.match(/interface\s+Request\w+\s+extends[^{]*\{[\s\S]*?\n\}/g) ?? [];
		const commands = blocks.flatMap(
			(block) => [...block.matchAll(/command: '([a-zA-Z]+)'/g)].map((match) => match[1])
		);
		assert.ok(commands.length > 50, `expected a full protocol, found only ${commands.length} requests`);
		return new Set(commands);
	}

	it('handles every request the webview can send', () => {
		const requests = requestCommands();
		const cases = new Set(
			[...read('src', 'gitGraphView.ts').matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1])
		);
		assert.deepEqual(
			[...requests].filter((command) => !cases.has(command)).sort(),
			[],
			'these requests would reach the default case and never be answered'
		);
	});

	it('handles no message the webview cannot send', () => {
		const requests = requestCommands();
		const cases = new Set(
			[...read('src', 'gitGraphView.ts').matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1])
		);
		assert.deepEqual(
			[...cases].filter((command) => !requests.has(command)).sort(),
			[],
			'these cases are dead code: no request carries their command'
		);
	});
});

/* ---------- The contributed commands ---------- */

describe('the contributed commands', () => {
	function registeredCommands() {
		const registered = [
			...read('src', 'commands.ts').matchAll(/registerCommand\('([^']+)'/g),
			...read('src', 'extension.ts').matchAll(/registerCommand\('([^']+)'/g)
		].map((match) => match[1]);
		return new Set(registered);
	}

	function contributedCommands() {
		const pkg = JSON.parse(read('package.json'));
		return new Set(pkg.contributes.commands.map((command) => command.command));
	}

	it('registers every command it contributes', () => {
		const registered = registeredCommands();
		assert.deepEqual(
			[...contributedCommands()].filter((command) => !registered.has(command)).sort(),
			[],
			'these commands appear in the Command Palette but nothing implements them'
		);
	});

	it('contributes every command it registers', () => {
		const contributed = contributedCommands();
		assert.deepEqual(
			[...registeredCommands()].filter((command) => !contributed.has(command)).sort(),
			[],
			'these commands are implemented but cannot be invoked from the UI'
		);
	});

	it('activates on every contributed command', () => {
		const pkg = JSON.parse(read('package.json'));
		const activationEvents = pkg.activationEvents.filter((event) => event.startsWith('onCommand:'));
		assert.ok(activationEvents.length > 0, 'expected command activation events');
		const contributed = contributedCommands();
		const activated = new Set(activationEvents.map((event) => event.slice('onCommand:'.length)));
		assert.deepEqual(
			[...activated].filter((command) => !contributed.has(command)).sort(),
			[],
			'these activation events point at commands that do not exist'
		);

		// Commands that show in the palette unconditionally need an activation event; the ones
		// gated by a `when` clause (openFile inside a diff editor) only ever run once the
		// extension is active already, exactly as in the original extension.
		const palette = pkg.contributes.menus['commandPalette'] ?? [];
		const unconditioned = palette
			.filter((entry) => entry.when === undefined)
			.map((entry) => entry.command);
		assert.deepEqual(
			unconditioned.filter((command) => !activated.has(command)).sort(),
			[],
			'these commands are always visible in the palette but would not activate the extension'
		);
	});

	it('points every menu entry at an existing command', () => {
		const pkg = JSON.parse(read('package.json'));
		const contributed = contributedCommands();
		const referenced = new Set();
		for (const location of Object.values(pkg.contributes.menus ?? {})) {
			for (const entry of location) {
				if (typeof entry.command === 'string') referenced.add(entry.command);
			}
		}
		assert.deepEqual(
			[...referenced].filter((command) => !contributed.has(command)).sort(),
			[],
			'these menu entries reference commands that are not contributed'
		);
	});
});

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
		const sources = [
			read('src', 'gitGraphView.ts'),
			read('src', 'statusBarItem.ts'),
			read('src', 'comparisonView.ts')
		].join('\n');

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
