import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The scenario registry's gates:
 *   - the load gates: a scenario without tags must FAIL to load; so must a write scenario
 *     without then.git, an unknown assertion kind, a malformed dom entry, a duplicated id, a
 *     broken byId wiring, and a replacement id that breaks the dotted shape;
 *   - the coverage gates: every write-op factory under src/extension/git/write/ops (extracted
 *     from the sources, never hand-written — the coverage matrix's own rule) has ≥ 1 SUCCESS
 *     and ≥ 1 FAILURE scenario; the then.git total meets the ≥ 82 bar;
 *   - the smoke gate: S1–S9 exist, tagged 'smoke';
 *   - evaluateThen's judgments: responses (present / missing / error + allowErrorOn), git, dom,
 *     refreshes and noErrors, each against a controlled fake.
 */

vi.mock('vscode', () => ({
	version: '1.90.0',
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3 },
	window: {},
	Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p, path: p }) },
	env: { clipboard: {} },
	commands: { executeCommand: () => Promise.resolve(undefined) },
	workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d, has: () => false, inspect: () => undefined, update: () => Promise.resolve() }) }
}));

import { AutomationAction } from './catalog/types';
import { MENUS_BRANCH_ACTIONS } from './catalog/menusBranch';
import { GitAssertion, GitStateProbe } from './gitStateProbe';
import { AutomationScenario, byId, DomExpectation, evaluateThen, ScenarioArtifacts, scenario, validateScenarios } from './scenario';
import { GIT_ASSERTION_COUNT, SCENARIOS } from './scenarios';

/** The checked-out branch action every wiring test wraps. */
const CHECKOUT = () => byId(MENUS_BRANCH_ACTIONS, 'menu-branch/checkout');

/** Extract the write-op factory names from the sources (the coverage matrix's own rule). */
function extractWriteOps(): string[] {
	const dir = path.resolve(process.cwd(), 'src/extension/git/write/ops');
	const ops: string[] = [];
	for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== 'index.ts' && !name.endsWith('.test.ts'))) {
		const source = fs.readFileSync(path.join(dir, file), 'utf8');
		for (const match of source.matchAll(/export function (\w+)\([^)]*\): WriteOp \{/g)) {
			ops.push(match[1]);
		}
	}
	return ops.sort();
}

describe('scenario() load gates', () => {
	it('accepts a well-formed scenario', () => {
		expect(() => scenario(CHECKOUT(), { ops: ['checkoutBranch'], then: { git: [{ kind: 'headIs', name: 'x' }] } })).not.toThrow();
	});

	it('fails to load a scenario without tags', () => {
		expect(() => scenario(CHECKOUT(), { tags: [], ops: ['checkoutBranch'], then: { noErrors: true } }))
			.toThrow('missing tags');
		expect(() => scenario(CHECKOUT(), { tags: ['not-the-group'], ops: ['checkoutBranch'], then: { noErrors: true } }))
			.toThrow('tags must include');
	});

	it('fails to load a write scenario without then.git', () => {
		expect(() => scenario(CHECKOUT(), { ops: ['checkoutBranch'], then: { noErrors: true } }))
			.toThrow('must assert then.git');
	});

	it('fails to load an unknown then.git assertion kind', () => {
		expect(() => scenario(CHECKOUT(), {
			ops: ['checkoutBranch'],
			then: { git: [{ kind: 'branchIsGreen' } as unknown as GitAssertion] }
		})).toThrow('unknown then.git assertion kind "branchIsGreen"');
	});

	it('fails to load a malformed then.dom entry', () => {
		expect(() => scenario({ ...CHECKOUT(), mutable: false }, {
			then: { dom: [{ colour: 'red' } as unknown as DomExpectation] }
		})).toThrow('malformed then.dom entry');
	});

	it('fails to load a scenario whose action shape is invalid (the action half is re-validated)', () => {
		const bad: AutomationAction = { ...CHECKOUT(), expect: { responses: [] }, mutable: true };
		expect(() => scenario(bad, { ops: ['checkoutBranch'], then: { git: [{ kind: 'headIs', name: 'x' }] } }))
			.toThrow('no expected responses');
	});

	it('fails to load an allowErrorOn entry the action does not expect', () => {
		expect(() => scenario(CHECKOUT(), {
			ops: ['checkoutBranch'],
			allowErrorOn: ['deleteBranch'],
			then: { git: [{ kind: 'headIs', name: 'x' }] }
		})).toThrow('allowErrorOn lists "deleteBranch"');
	});

	it('fails to load a replacement id that breaks the dotted shape', () => {
		expect(() => scenario(CHECKOUT(), {
			id: 'not-dotted',
			tags: ['menu-branch'],
			ops: ['checkoutBranch'],
			then: { git: [{ kind: 'headIs', name: 'x' }] }
		})).toThrow('must keep the <group>/<name> shape');
	});

	it('fails the wiring when the wrapped catalog action does not exist', () => {
		expect(() => byId(MENUS_BRANCH_ACTIONS, 'menu-branch/no-such-action')).toThrow('not found');
	});
});

describe('validateScenarios cross-entry gates', () => {
	const base: AutomationScenario = scenario(CHECKOUT(), { ops: ['checkoutBranch'], then: { git: [{ kind: 'headIs', name: 'x' }] } });

	it('reports a scenario without tags and a duplicate id', () => {
		const untagged = { ...base, tags: [] } as AutomationScenario;
		expect(validateScenarios([base, untagged])).toContainEqual('scenario "menu-branch/checkout": missing tags (a scenario without tags must not load)');
		expect(validateScenarios([base, { ...base }])).toContainEqual('scenario "menu-branch/checkout": duplicate id');
	});

	it('reports a write scenario without then.git', () => {
		const noGit = { ...base, then: { noErrors: true } } as AutomationScenario;
		expect(validateScenarios([noGit])).toContainEqual('scenario "menu-branch/checkout": a write scenario must carry at least one then.git assertion');
	});

	it('accepts the assembled registry', () => {
		expect(validateScenarios(SCENARIOS)).toEqual([]);
	});
});

describe('the assembled scenario registry', () => {
	it('gives every scenario at least one tag including its group', () => {
		for (const entry of SCENARIOS) {
			expect(entry.tags.length, entry.id).toBeGreaterThan(0);
			expect(entry.tags.includes(entry.group), entry.id).toBe(true);
		}
	});

	it('covers every write operation with a success and a failure scenario', () => {
		const ops = extractWriteOps();
		expect(ops.length).toBeGreaterThanOrEqual(41); // the plan's count; the sources hold more
		const failures = SCENARIOS.filter((entry) => entry.tags.includes('failure'));
		const successes = SCENARIOS.filter((entry) => !entry.tags.includes('failure'));
		const gaps: string[] = [];
		for (const op of ops) {
			if (!successes.some((entry) => entry.ops?.includes(op))) gaps.push(op + ' (success)');
			if (!failures.some((entry) => entry.ops?.includes(op))) gaps.push(op + ' (failure)');
		}
		expect(gaps, 'write-op scenarios missing: ' + gaps.join(', ')).toEqual([]);
	});

	it('meets the >= 82 then.git acceptance bar', () => {
		let manual = 0;
		for (const entry of SCENARIOS) manual += entry.then.git?.length ?? 0;
		expect(GIT_ASSERTION_COUNT).toBe(manual);
		expect(GIT_ASSERTION_COUNT).toBeGreaterThanOrEqual(82);
	});

	it('carries the smoke checklist S1-S9, all tagged smoke', () => {
		for (let i = 1; i <= 9; i++) {
			const entry = SCENARIOS.find((candidate) => candidate.id === 'smoke/S' + i);
			expect(entry, 'smoke/S' + i + ' is missing').toBeDefined();
			expect(entry!.tags).toContain('smoke');
		}
	});

	it('answers every former nativeSaveDialog archive flow through the ScriptedUiPort', () => {
		const archives = SCENARIOS.filter((entry) => entry.ops?.includes('archive'));
		expect(archives.length).toBeGreaterThanOrEqual(2); // the confirm and the cancel branch
		expect(archives.some((entry) => (entry.answers ?? []).some((answer) => answer.dialog === 'save' && answer.path !== null))).toBe(true);
		expect(archives.some((entry) => (entry.answers ?? []).some((answer) => answer.dialog === 'save' && answer.path === null))).toBe(true);
	});

	it('declares no fixed-duration sleeps (then-only waits on conditions)', () => {
		for (const entry of SCENARIOS) {
			for (const step of entry.ui ?? []) {
				expect('sleepMs' in step && step.sleepMs !== undefined, entry.id).toBe(false);
			}
		}
	});
});

describe('evaluateThen', () => {
	/** A probe fake judging from a fixed verdict table. */
	function fakeProbe(verdicts: readonly string[]): { probe: GitStateProbe; calls: string[] } {
		const calls: string[] = [];
		const probe = {
			assertAll: async (assertions: readonly GitAssertion[]) => {
				calls.push(assertions.map((assertion) => assertion.kind).join(','));
				return verdicts[0] ?? null;
			}
		} as unknown as GitStateProbe;
		return { probe, calls };
	}

	const artifacts = (overrides: Partial<ScenarioArtifacts> = {}): ScenarioArtifacts => ({
		runOk: true,
		runError: null,
		seenResponses: [{ command: 'checkoutBranch', error: null }],
		refreshCount: 1,
		hostErrors: [],
		...overrides
	});

	it('passes a fully satisfied then-block and fails each unsatisfied judgment', async () => {
		const entry = scenario(CHECKOUT(), {
			ops: ['checkoutBranch'],
			then: {
				git: [{ kind: 'headIs', name: '{{branch}}' }],
				dom: [{ absent: '.gone' }],
				refreshes: 1,
				noErrors: true
			}
		});
		const { probe, calls } = fakeProbe([]);
		const domOk = async () => null;
		await expect(evaluateThen(entry, artifacts(), probe, domOk, { branch: 'local-ahead' })).resolves.toEqual([]);
		expect(calls).toEqual(['headIs']);
	});

	it('fails a missing expected response', async () => {
		const entry = scenario({ ...CHECKOUT(), mutable: false }, { ops: ['checkoutBranch'], then: { responses: ['deleteBranch'] } });
		const { probe } = fakeProbe([]);
		const failures = await evaluateThen(entry, artifacts(), probe, async () => null);
		expect(failures).toContain('responses: expected a "deleteBranch" response, none arrived');
	});

	it('fails an error-bearing response unless allowErrorOn lists it', async () => {
		const clean = scenario({ ...CHECKOUT(), mutable: false }, { ops: ['checkoutBranch'], then: {} });
		const withError = artifacts({ seenResponses: [{ command: 'checkoutBranch', error: 'git refused' }] });
		const { probe } = fakeProbe([]);
		expect(await evaluateThen(clean, withError, probe, async () => null))
			.toContain('responses: "checkoutBranch" arrived with an error: git refused');
		const allowed = scenario({ ...CHECKOUT(), mutable: false }, { ops: ['checkoutBranch'], allowErrorOn: ['checkoutBranch'], then: {} });
		await expect(evaluateThen(allowed, withError, probe, async () => null)).resolves.toEqual([]);
	});

	it('expands {{placeholders}} inside then.git assertions before the probe judges', async () => {
		let seen: readonly GitAssertion[] = [];
		const probe = {
			assertAll: async (assertions: readonly GitAssertion[]) => {
				seen = assertions;
				return null;
			}
		} as unknown as GitStateProbe;
		const entry = scenario(CHECKOUT(), {
			ops: ['checkoutBranch'],
			then: { git: [{ kind: 'headIs', name: '{{branch}}' }, { kind: 'refAbsent', ref: '{{branch}}-renamed' }] }
		});
		await evaluateThen(entry, artifacts(), probe, async () => null, { branch: 'feature-9' });
		expect(seen).toEqual([
			{ kind: 'headIs', name: 'feature-9' },
			{ kind: 'refAbsent', ref: 'feature-9-renamed' }
		]);
	});

	it('reports the probe verdict, dom verdict, refresh mismatch and host errors', async () => {
		const entry = scenario(CHECKOUT(), {
			ops: ['checkoutBranch'],
			then: {
				git: [{ kind: 'headIs', name: 'x' }],
				dom: [{ present: '.missing' }],
				refreshes: 2,
				noErrors: true
			}
		});
		const { probe } = fakeProbe(['expected HEAD to be "x", got "main"']);
		const failures = await evaluateThen(entry, artifacts({ refreshCount: 1, runOk: false, runError: 'boom', hostErrors: ['logged error'] }), probe, async () => 'selector never appeared');
		expect(failures).toContain('expected HEAD to be "x", got "main"');
		expect(failures).toContain('dom: selector never appeared');
		expect(failures).toContain('refreshes: expected 2, observed 1');
		expect(failures).toContain('noErrors: the run itself failed: boom');
		expect(failures).toContain('noErrors: host logged 1 error(s): logged error');
	});
});
