/**
 * CLI parsing for `npm run test:e2e -- <flags>` (§6.8.7): --tier, --grep, --vscode, --backend,
 * --lang, --headed, --keep-open, --base, --timeout, and the fixture size knobs. Shared by the
 * launcher (which parses) and the entry (which re-reads the serialized options), so the flag
 * surface lives in exactly one place.
 */

import { Backend, DEFAULT_E2E_OPTIONS, E2eOptions, Tier, UiLanguage } from './types';

const TIERS: readonly Tier[] = ['smoke', 'affected', 'full', 'perf'];
const BACKENDS: readonly Backend[] = ['engine', 'cli', 'nogit'];
const LANGS: readonly UiLanguage[] = ['en', 'zh-cn'];

const USAGE = `Usage:
  npm run test:e2e -- [--tier smoke|affected|full|perf] [--grep <id-or-tag-substring>]
      [--vscode stable|insiders|<version>] [--backend engine|cli|nogit] [--lang en|zh-cn]
      [--headed] [--keep-open] [--base <ref>] [--timeout <ms>]
      [--commits <n>] [--branches <n>] [--tags <n>] [--authors <n>] [--seed <n>]

Downloads (and caches in .vscode-test/) the requested VS Code, launches it isolated against the
automation build of the extension, generates the fixture repository and runs the selected
scenarios. The perf tier is the non-gated D-2 measurement (hidden -> visible restore with and
without retained webview context). Reports land in test/e2e/results/<run>/ (JUnit XML, JSON,
HTML), plus the P4 trace summaries the launcher collects from the session log.`;

export class OptionsError extends Error {
	public constructor(message: string) {
		super(message + '\n\n' + USAGE);
	}
}

function positiveInt(value: string, flag: string): number {
	const parsed = parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 0) throw new OptionsError(flag + ' must be a non-negative integer');
	return parsed;
}

/** Parse the launcher's argv into {@link E2eOptions}; exits on `--help`. */
export function parseOptions(argv: readonly string[]): E2eOptions {
	const set: { -readonly [K in keyof E2eOptions]: E2eOptions[K] } = { ...DEFAULT_E2E_OPTIONS };
	const fixture = { ...DEFAULT_E2E_OPTIONS.fixture };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			if (i + 1 >= argv.length) throw new OptionsError(arg + ' requires a value');
			return argv[++i];
		};
		switch (arg) {
			case '--help':
			case '-h':
				process.stdout.write(USAGE + '\n');
				process.exit(0);
				break;
			case '--tier': {
				const value = next();
				if (!TIERS.includes(value as Tier)) throw new OptionsError('--tier must be one of ' + TIERS.join('|'));
				set.tier = value as Tier;
				break;
			}
			case '--grep':
				set.grep = next();
				break;
			case '--vscode':
				set.vscodeVersion = next();
				break;
			case '--backend': {
				const value = next();
				if (!BACKENDS.includes(value as Backend)) throw new OptionsError('--backend must be one of ' + BACKENDS.join('|'));
				set.backend = value as Backend;
				break;
			}
			case '--lang': {
				const value = next();
				if (!LANGS.includes(value as UiLanguage)) throw new OptionsError('--lang must be one of ' + LANGS.join('|'));
				set.lang = value as UiLanguage;
				break;
			}
			case '--headed':
				set.headed = true;
				break;
			case '--keep-open':
				set.keepOpen = true;
				break;
			case '--base':
				set.base = next();
				break;
			case '--timeout':
				set.actionTimeoutMs = positiveInt(next(), '--timeout');
				break;
			case '--commits':
				fixture.commits = positiveInt(next(), '--commits');
				break;
			case '--branches':
				fixture.branches = positiveInt(next(), '--branches');
				break;
			case '--tags':
				fixture.tags = positiveInt(next(), '--tags');
				break;
			case '--authors':
				fixture.authors = positiveInt(next(), '--authors');
				break;
			case '--seed':
				fixture.seed = positiveInt(next(), '--seed');
				break;
			default:
				throw new OptionsError('unknown argument ' + arg);
		}
	}
	set.fixture = fixture;
	return set;
}

/** Serialize for the entry (E2E_RUN_OPTIONS). */
export function serializeOptions(options: E2eOptions): string {
	return JSON.stringify(options);
}

/** The entry's counterpart: parse E2E_RUN_OPTIONS, falling back to the defaults. */
export function deserializeOptions(raw: string | undefined): E2eOptions {
	if (raw === undefined || raw === '') return DEFAULT_E2E_OPTIONS;
	try {
		const parsed = JSON.parse(raw) as Partial<E2eOptions>;
		return { ...DEFAULT_E2E_OPTIONS, ...parsed, fixture: { ...DEFAULT_E2E_OPTIONS.fixture, ...(parsed.fixture ?? {}) } };
	} catch {
		return DEFAULT_E2E_OPTIONS;
	}
}
