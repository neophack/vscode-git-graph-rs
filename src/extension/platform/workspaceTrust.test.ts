import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Workspace Trust gate over the compat probe: absent the API
 * (VS Code < 1.56, test stubs) the gate is permanently trusted and never fires — the pre-1.56
 * behaviour — while a present API is mirrored, transitions included.
 */
const vscodeMock = vi.hoisted(() => ({ workspace: {} as Record<string, unknown> }));

vi.mock('vscode', () => vscodeMock);

import { STRINGS_EN } from '../../shared/i18n';
import { createTrustGate } from './workspaceTrust';

/** A minimal Workspace Trust surface whose trust level the test flips. */
function installTrustSurface(initial: boolean): { setTrusted(value: boolean): void } {
	const listeners: Array<() => void> = [];
	vscodeMock.workspace = {
		isTrusted: initial,
		onDidChangeWorkspaceTrust: (listener: () => void) => {
			listeners.push(listener);
			return { dispose() { /* nothing */ } };
		}
	};
	return {
		setTrusted(value: boolean) {
			(vscodeMock.workspace as { isTrusted: boolean }).isTrusted = value;
			for (const listener of [...listeners]) listener();
		}
	};
}

beforeEach(() => {
	vscodeMock.workspace = {};
});

describe('createTrustGate without the Workspace Trust API', () => {
	it('treats the workspace as trusted and never fires a transition', () => {
		const gate = createTrustGate();
		expect(gate.isTrusted).toBe(true);

		const listener = vi.fn();
		const subscription = gate.onChange(listener);
		expect(listener).not.toHaveBeenCalled();
		expect(() => subscription.dispose()).not.toThrow();
	});
});

describe('createTrustGate over a real Workspace Trust API', () => {
	it('mirrors the current trust level', () => {
		installTrustSurface(true);
		expect(createTrustGate().isTrusted).toBe(true);
		installTrustSurface(false);
		expect(createTrustGate().isTrusted).toBe(false);
	});

	it('fires the change listener on every trust transition, and the gate re-reads the level', () => {
		const surface = installTrustSurface(false);
		const gate = createTrustGate();
		expect(gate.isTrusted).toBe(false);

		const listener = vi.fn(() => undefined);
		gate.onChange(listener);

		surface.setTrusted(true);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(gate.isTrusted).toBe(true);

		surface.setTrusted(false);
		expect(listener).toHaveBeenCalledTimes(2);
		expect(gate.isTrusted).toBe(false);
	});

	it('carries an English-only notice (the i18n dictionaries are out of scope for the trust change)', () => {
		expect(STRINGS_EN.restrictedModeNotice).toMatch(/^Git Graph RS: /);
		expect(STRINGS_EN.restrictedModeNotice).toMatch(/not trusted/);
	});
});
