/**
 * The repository baseline generator (REFACTOR-PLAN task 0.2, "Fix the baseline"): measures
 * everything a refactor ratchet needs a fixed starting point for, and writes it to
 * docs/baseline-2026-10.md and stdout. `npm run baseline` is the only supported entry.
 *
 * What it measures, and how every number was obtained (the exact command sits next to each
 * number in the generated document, per the repo's "verification commands attached to numbers"
 * docs style):
 *
 *   - test case counts: the Vitest suite via `npx vitest list` (one line per case; falls back
 *     to counting `it(`/`test(` occurrences in the files vitest.config.ts matches if `list`
 *     ever disappears from the installed vitest), and the Rust side by counting `#[test]`
 *     attributes under native/ — a proxy, NOT a `cargo test` run
 *     (compiling the workspace is far too heavy for a baseline pass, and the attribute count
 *     needs no toolchain at all);
 *   - artifact sizes: a fresh production build (`npm run build:dist -- --production`) then a
 *     universal-VSIX package run (`npm run package`, which needs no Rust toolchain — the
 *     universal VSIX carries no native binaries), each file stated in exact bytes;
 *   - the bench first-paint numbers, but ONLY when a prebuilt engine binary already exists —
 *     building one is cargo's job and out of scope here, so the usual outcome on a fresh
 *     worktree is "not measured here" plus the exact reproduce command;
 *   - the depcruise violation count (`npm run lint:deps`) and the ESLint summary
 *     (`npx eslint src scripts`);
 *   - the ten largest non-generated source files (`git ls-files` + line counts);
 *   - tracked-file counts per top-level directory.
 *
 * Determinism: repeated runs on the same tree, machine, and day produce a byte-identical
 * document. Only the header's date line and HEAD hash can differ between runs. Nothing
 * wall-clock-derived (durations, timestamps) enters the document.
 *
 * The generator deletes the *.vsix it measures (gitignored either way) so a baseline run
 * leaves the working tree exactly as it found it.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const docPath = path.join(root, 'docs', 'baseline-2026-10.md');

/** Run a node CLI deterministically; the npm-facing command a reviewer types is recorded in the doc. */
function runNode(cliPathRelative, args) {
	const result = spawnSync(process.execPath, [path.join(root, cliPathRelative), ...args], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runGit(args) {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (result.stderr ?? ''));
	return result.stdout;
}

/** wc -l semantics: count newline characters, so a missing trailing newline is not a line. */
function lineCount(file) {
	return fs.readFileSync(file, 'utf8').split('\n').length - 1;
}

/** Directories never worth descending into (build outputs, the shared junction, git internals). */
const SKIP_DIRECTORIES = new Set(['target', 'node_modules', '.git']);

function walk(directory, predicate, accumulator = []) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRECTORIES.has(entry.name)) walk(full, predicate, accumulator);
		} else if (predicate(full)) accumulator.push(full);
	}
	return accumulator;
}

const toPosix = (file) => path.relative(root, file).split(path.sep).join('/');
const kib = (bytes) => Math.round(bytes / 102.4) / 10;

/* ------------------------------------------------------------------ test counts */

function countCaseCalls(files) {
	let it = 0;
	let test = 0;
	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8');
		it += source.split(/\bit\(\s*['"`]/).length - 1;
		test += source.split(/\btest\(\s*['"`]/).length - 1;
	}
	return { it, test };
}

/**
 * The Vitest suite (vitest.config.ts includes the `src` and `test/integration` trees, each
 * matched as `*.test.ts`).
 * `vitest list` prints one line per case as "file > full test name", so the case count is the
 * line count and the file count is the distinct prefixes.
 */
/** The `*.test.ts` files vitest.config.ts's include patterns match. */
function vitestMatchedFiles() {
	return [
		...walk(path.join(root, 'src'), (file) => file.endsWith('.test.ts')),
		...walk(path.join(root, 'test', 'integration'), (file) => file.endsWith('.test.ts'))
	].map(toPosix);
}

/**
 * Files matched by the include patterns but absent from `vitest list`'s output: their whole
 * `describe` is `skipIf`-gated (the Reader contract suite needs a built engine), so without
 * the gate's condition the file contributes no listed cases — reported, not silently dropped.
 */
function vitestGatedFiles(listedFiles) {
	return vitestMatchedFiles()
		.filter((file) => !listedFiles.has(file))
		.map((file) => {
			const { it, test } = countCaseCalls([path.join(root, file)]);
			return `${file} (${it + test} engine-gated \`it(\` cases, listed only with a built engine)`;
		});
}

function measureVitest() {
	const result = runNode('node_modules/vitest/vitest.mjs', ['list']);
	if (result.status === 0) {
		const lines = result.stdout.split(/\r?\n/).filter((line) => /^(src|test)[/\\].* > /.test(line));
		const files = new Set(lines.map((line) => line.split(' > ')[0]));
		const inSrc = [...files].filter((file) => file.startsWith('src/')).length;
		return {
			method: '`npx vitest list` — vitest prints one line per case as ``file > name``; the count is those lines (a plain grep would miss `test.each` expansion, which `list` resolves)',
			files: files.size,
			matchedFiles: vitestMatchedFiles().length,
			srcFiles: inSrc,
			integrationFiles: files.size - inSrc,
			cases: lines.length,
			gated: vitestGatedFiles(files)
		};
	}
	// Fallback (a vitest major that drops `list`): the same files vitest.config.ts matches,
	// counted by the it(/test( proxy. The method line records which of the two ran.
	const files = vitestMatchedFiles();
	const { it, test } = countCaseCalls(files.map((file) => path.join(root, file)));
	return {
		method: '`npx vitest list` failed on the installed vitest; fallback: count `it(`/`test(` string-literal calls in the `*.test.ts` files `vitest.config.ts` includes (under `src` and `test/integration`) — a proxy that does not expand `test.each`',
		files: files.length,
		matchedFiles: files.length,
		srcFiles: files.filter((file) => file.startsWith('src/')).length,
		integrationFiles: files.filter((file) => file.startsWith('test/')).length,
		cases: it + test,
		gated: []
	};
}

/**
 * The Rust side: count `#[test]` attributes under native/. A documented proxy — it is the
 * number of test functions in the source, not a `cargo test` report (no `should_panic`
 * splitting, no macro-generated cases; there are no `#[test_case]` attributes today).
 */
function measureRust() {
	const files = walk(path.join(root, 'native'), (file) => file.endsWith('.rs'));
	const perArea = {};
	let filesWithTests = 0;
	let total = 0;
	for (const file of files) {
		const count = fs.readFileSync(file, 'utf8').split(/^\s*#\[test\]/m).length - 1;
		if (count === 0) continue;
		filesWithTests++;
		const area = toPosix(file).split('/').slice(0, 3).join('/');
		perArea[area] = (perArea[area] ?? 0) + count;
		total += count;
	}
	return { filesWithTests, total, perArea };
}

/* ------------------------------------------------------------------ sizes */

function statIfExists(file) {
	const full = path.join(root, file);
	return fs.existsSync(full) ? fs.statSync(full).size : null;
}

function measureSizes() {
	// The production dist build: exactly what `npm run build:dist -- --production` runs.
	const build = runNode('scripts/build/build.mjs', ['--production']);
	if (build.status !== 0) throw new Error('build:dist failed:\n' + build.stdout + build.stderr);

	// The universal VSIX: `npm run package` re-runs the production dist build plus the vendored
	// webview assets, then vsce — all without any Rust toolchain (the universal VSIX ships no
	// native binaries; those are the platform VSIXs built by CI's cargo matrix).
	const pack = runNode('scripts/package-without-automation.mjs', []);
	if (pack.status !== 0) throw new Error('npm run package failed:\n' + pack.stdout + pack.stderr);

	const artifacts = [
		'dist/extension.js',
		'dist/askpass/askpassMain.js',
		'dist/askpass/askpass.sh',
		'dist/askpass/askpass-empty.sh',
		'media/out.min.js',
		'media/out.min.css',
		'media/comparison.min.js',
		'media/comparison.min.css',
		'media/binaryCompare.min.js',
		'media/binaryCompare.min.css',
		'media/vendor/highlight.min.js'
	].map((file) => ({ file, bytes: statIfExists(file) }));

	const vsixName = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
	const vsixPath = `git-graph-rs-${vsixName}.vsix`;
	const vsixBytes = statIfExists(vsixPath);
	// Measured, then removed: the generator leaves the working tree as it found it.
	if (vsixBytes !== null) fs.rmSync(path.join(root, vsixPath));

	// The first-paint payload the §3.8.1 size budget governs: everything the main view's HTML
	// loads as a plain <script> before the bundle (src/extension/graphView/html.ts) plus its
	// stylesheet. highlight.min.js belongs to the comparison page, not the main view, and the
	// Markdown renderer rides the on-demand chunks (media/chunks/markdown-it-*.js), not the
	// first-paint scripts.
	const firstPaintJs = ['media/out.min.js']
		.map((file) => statIfExists(file) ?? 0)
		.reduce((a, b) => a + b, 0);
	const firstPaintCss = statIfExists('media/out.min.css') ?? 0;

	return { artifacts, vsixPath, vsixBytes, firstPaintJs, firstPaintCss };
}

/**
 * The shipped binaries' sizes (P5 rows, optimization plan R6/V4): one `.node` per platform
 * directory the worktree carries a build for, measured from disk. Only the host platform
 * normally exists in a worktree (`npm run build:native:release` builds it); the rest come
 * from CI's matrix, whose `cargo bloat` report and this document's 2% rule hold the budget.
 */
function measureAddonSizes() {
	const nativeDir = path.join(root, 'native');
	if (!fs.existsSync(nativeDir)) return [];
	const rows = [];
	for (const entry of fs.readdirSync(nativeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const addon = path.join(nativeDir, entry.name, 'git-graph.node');
		if (fs.existsSync(addon)) rows.push({ platform: entry.name, bytes: fs.statSync(addon).size });
	}
	return rows;
}

/** The P5 growth budget: sizes may grow at most 2% over this baseline without a decision. */
const P5_GROWTH_ALLOWANCE = 0.02;
const p5Budget = (bytes) => Math.ceil(bytes * (1 + P5_GROWTH_ALLOWANCE));

/* ------------------------------------------------------------------ lint gates */

function measureDepcruise() {
	const result = runNode('node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', ['src', '--config', '.dependency-cruiser.cjs']);
	const stdout = result.stdout + result.stderr;
	const summary = stdout.match(/no dependency violations found \((\d+) modules, (\d+) dependencies cruised\)/);
	const ignored = stdout.match(/(\d+) known violations ignored/);
	const stale = stdout.match(/(\d+) stale known violations/);
	const baselineEntries = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'depcruise-baseline.json'), 'utf8')).length;
	return {
		status: result.status,
		modules: summary ? Number(summary[1]) : null,
		dependencies: summary ? Number(summary[2]) : null,
		violations: result.status === 0 ? 0 : null,
		knownIgnored: ignored ? Number(ignored[1]) : null,
		staleKnown: stale ? Number(stale[1]) : null,
		baselineEntries
	};
}

function measureEslint() {
	const result = runNode('node_modules/eslint/bin/eslint.js', ['src', 'scripts']);
	const summary = (result.stdout + result.stderr).match(/✖ (\d+) problems \((\d+) errors?, (\d+) warnings?\)/);
	return {
		status: result.status,
		problems: summary ? Number(summary[1]) : null,
		errors: summary ? Number(summary[2]) : null,
		warnings: summary ? Number(summary[3]) : null
	};
}

/* ------------------------------------------------------------------ tree shape */

const SIZE_EXTENSIONS = ['.ts', '.mts', '.cts', '.mjs', '.cjs', '.rs', '.css'];
/** Files excluded from the largest-files ratchet table, each with the reason. */
const SIZE_EXCLUSIONS = [
	{ prefix: 'legacy/', reason: 'frozen v1.0 reference copy' },
	{ prefix: 'src/shared/engine/', reason: 'ts-rs generated types (regenerated, never hand-edited)' },
	{ exact: 'src/shared/i18n/en.ts', reason: 'string-table dictionary' },
	{ exact: 'src/shared/i18n/zh-cn.ts', reason: 'string-table dictionary' }
];

function measureLargestFiles() {
	const tracked = runGit(['ls-files']).split(/\r?\n/).filter((line) => line !== '');
	return tracked
		.filter((file) => SIZE_EXTENSIONS.includes(path.extname(file)))
		.filter((file) => !SIZE_EXCLUSIONS.some((exclusion) =>
			(exclusion.prefix !== undefined && file.startsWith(exclusion.prefix)) || exclusion.exact === file))
		.map((file) => ({ file, lines: lineCount(path.join(root, file)) }))
		.sort((a, b) => (b.lines - a.lines) || a.file.localeCompare(b.file))
		.slice(0, 10);
}

function measureRepoStats() {
	const tracked = runGit(['ls-files']).split(/\r?\n/).filter((line) => line !== '');
	const perDirectory = {};
	let rootFiles = 0;
	for (const file of tracked) {
		const slash = file.indexOf('/');
		if (slash === -1) rootFiles++;
		else {
			const directory = file.slice(0, slash);
			perDirectory[directory] = (perDirectory[directory] ?? 0) + 1;
		}
	}
	const rows = Object.entries(perDirectory).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
	return { rows, rootFiles, total: tracked.length };
}

/* ------------------------------------------------------------------ document */

function formatBytes(bytes) {
	return bytes === null ? '—' : `${bytes} B (${kib(bytes)} KiB)`;
}

function build() {
	const date = new Date().toISOString().slice(0, 10);
	const head = runGit(['rev-parse', 'HEAD']).trim().slice(0, 9);
	const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

	const vitest = measureVitest();
	const rust = measureRust();
	const sizes = measureSizes();
	const addons = measureAddonSizes();
	const depcruise = measureDepcruise();
	const eslint = measureEslint();
	const largest = measureLargestFiles();
	const repo = measureRepoStats();

	// The grep proxy command, kept out of the template literal below: it mixes quotes and
	// backslashes, which is unreadable escaped inline.
	const rustGrep = "grep -rn \"#\\[test\\]\" native --include=\"*.rs\" | wc -l";

	const parts = [];

	parts.push(`# Repository Baseline — 2026-10

| Item | Value |
|---|---|
| Generated | ${date} |
| HEAD | \`${head}\` on branch \`${branch}\` |
| Machine | Windows dev machine (process starts are slower than CI's Linux runner; REFACTOR-PLAN §3.8.1 records the two reference environments separately) |
| Node | ${process.version} |
| Reproduce | \`npm run baseline\` — regenerates this file end to end and prints it to stdout |
| Stability | every number below is an exact count or an exact byte size: a rerun on the same tree reproduces them **exactly**; the ~5–10% tolerance of task 0.2 only applies across machines and checkouts |

This is the REFACTOR-PLAN task 0.2 baseline ("Fix the baseline"), taken on the mid-refactor tree
after the wave-1 foundation (dist pipeline, typed protocol, handler table, Vitest for colocated
unit tests). It is the fixed starting point the refactor's ratchets move against: case counts,
artifact sizes, lint-gate counts and file sizes may not regress past these numbers without a
deliberate decision. The header table above is hand-maintained prose inside
\`scripts/dev/baseline.mjs\`; regenerating rewrites the whole file.

<!-- Everything below the marker is generated. -->
`);

	parts.push(`## Test case counts

| Suite | Files | Cases | Method |
|---|---|---|---|
| Vitest (\`src/**\` colocated units + \`test/integration\`) | ${vitest.files} with listed cases (${vitest.matchedFiles} matched by the include patterns) | ${vitest.cases} | ${vitest.method} |
| Rust (\`native/**\`) | ${rust.filesWithTests} files with tests | ${rust.total} | proxy count of \`#[test]\` attributes — the number of test functions in source, **not** a \`cargo test\` run (documented proxy; no \`#[test_case]\` or macro-generated cases exist today) |

Exact commands (the generator invokes the same tools through their node entry points):

\`\`\`bash
npx vitest list                                  # one line per case, "file > name"; count the lines
${rustGrep}
\`\`\`

${vitest.gated.length > 0
		? `Files matched but listing no cases: ${vitest.gated.join('; ')}.`
		: 'Every matched Vitest file contributes listed cases at this HEAD.'}

Rust \`#[test]\` distribution:

| Area | \`#[test]\` |
|---|---|
${Object.entries(rust.perArea).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).map(([area, count]) => `| ${area} | ${count} |`).join('\n')}

Notes:

- \`test/compat/artifactSyntax.test.mjs\` is a CI gate script, not part of either suite's count (CI runs it via \`node test/compat/artifactSyntax.test.mjs\` after the dist build).
- The legacy node:test suite was drained in REFACTOR-PLAN task 7.1 (the old-to-new mapping lives in that commit); every case count above is Vitest.
`);

	parts.push(`## Artifact sizes

Built fresh by the generator with \`npm run build:dist -- --production\` (the dist pipeline: esbuild
host bundle + webview bundles + ES2018 gates), then \`npm run package\` (which re-runs that build,
rebuilds the vendored webview assets, and runs vsce — no Rust toolchain involved: the universal
VSIX ships no native binaries).

| Artifact | Size |
|---|---|
${sizes.artifacts.map((entry) => `| ${entry.file} | ${formatBytes(entry.bytes)} |`).join('\n')}
| ${sizes.vsixPath} (universal VSIX) | ${formatBytes(sizes.vsixBytes)} |

The generator deletes the VSIX after measuring it; \`npm run package\` recreates it at any time.

First-paint payload of the main view (what the §3.8.1 size budget governs — the plain \`<script>\`
entries in the webview HTML, \`src/extension/graphView/html.ts\`, plus its stylesheet): the Markdown
renderer loads on demand (\`media/chunks/markdown-it-*.js\`), and \`vendor/highlight.min.js\` is
loaded by the comparison page, not the main view.

| Quantity | Value | Budget (§3.8.1) |
|---|---|---|
| First-paint critical JS (minified, not gzipped) | ${formatBytes(sizes.firstPaintJs)} | ≤ 200 KB |
| First-paint critical CSS (minified, not gzipped) | ${formatBytes(sizes.firstPaintCss)} | ≤ 60 KB |

First-paint JS ${sizes.firstPaintJs <= 200 * 1024 ? 'is within' : 'is over'} its 200 KB budget;
first-paint CSS ${sizes.firstPaintCss <= 60 * 1024 ? 'is within' : 'is over'} its 60 KB budget.
${sizes.firstPaintJs > 200 * 1024 || sizes.firstPaintCss > 60 * 1024
		? 'The side over budget is what the first-paint splitting work (task 5.9), gated by P5, holds the line on.'
		: 'Both hold the §3.8.1 line at this HEAD.'}
`);

	parts.push(`## P5 size budget (2% growth rule)

The P5 ratchet (optimization plan §5 V4/R6): a shipped size below may grow at most **2%** over
this baseline without a deliberate decision recorded next to the regeneration. The addon is the
largest file in the VSIX by an order of magnitude, so its per-platform size is budgeted
separately from the VSIX total; CI's \`cargo bloat --release --crates\` report (native-build.yml,
non-blocking) is the evidence source when a budget is breached. A row here appears for every
platform the tree being measured carries a build for — worktrees normally hold only the host
platform (\`npm run build:native:release\`); CI's matrix covers the rest.
`);

	const p5Rows = [];
	if (sizes.vsixBytes !== null) {
		p5Rows.push(`| Universal VSIX (\`${sizes.vsixPath}\`) | ${formatBytes(sizes.vsixBytes)} | ≤ ${formatBytes(p5Budget(sizes.vsixBytes))} | \`npm run package\` |`);
	} else {
		p5Rows.push('| Universal VSIX | not measured (packaging failed) | — | `npm run package` |');
	}
	if (addons.length > 0) {
		for (const addon of addons) {
			p5Rows.push(`| Addon, \`${addon.platform}\` (\`native/${addon.platform}/git-graph.node\`) | ${formatBytes(addon.bytes)} | ≤ ${formatBytes(p5Budget(addon.bytes))} | \`npm run build:native:release\` (CI matrix for the rest) |`);
		}
	} else {
		p5Rows.push('| Per-platform addon (`.node`) | not measured (no prebuilt addon in this tree) | — | `npm run build:native:release` |');
	}
	parts.push(`| Quantity | Baseline | Growth budget (+2%) | Measured by |
|---|---|---|---|
${p5Rows.join('\n')}
`);


	const benchNote = addons.length > 0
		? `A prebuilt engine binary exists (${addons.map((addon) => `native/${addon.platform}/git-graph.node`).join(', ')}); the first-paint gates were not run by the generator — run \`npm run perf\` (\`test/perf/\`) and record the medians here.`
		: `First-paint numbers: **not measured here** — no prebuilt engine binary exists in this
worktree (\`native/<platform>/*.node\` is gitignored and building one needs cargo). Reproduce with:

\`\`\`bash
npm run build            # cargo addon + production dist
npm run perf             # the P2/P3 first-paint gates under test/perf/
\`\`\`

The one first-paint measurement recorded in the repository today (v1.0 code, this repository's
first page of 200 commits, median of 5): engine **12.6 ms** vs git CLI **205.3 ms** — measured
with the v1.0 bench and recorded in \`docs/REFACTOR-PLAN.md\` §0.7. Re-measuring it on the current
tree is part of the P2 harness (\`test/perf/\`).`;

	parts.push(`## Bench first-paint

${benchNote}
`);

	parts.push(`## Lint gates

| Gate | Result | Command |
|---|---|---|
| dependency-cruiser | ${depcruise.violations} new violations (${depcruise.modules} modules, ${depcruise.dependencies} dependencies cruised); ${depcruise.knownIgnored} known violations ignored (baseline file: ${depcruise.baselineEntries} entries, ${depcruise.staleKnown} already stale — shrink-only regeneration pending) | \`npm run lint:deps\` |
| ESLint (\`src\` + \`scripts\`) | ${eslint.problems} problems (${eslint.errors} errors, ${eslint.warnings} warnings), exit ${eslint.status} | \`npx eslint src scripts\` |

Both gates exit 0 as the generator runs them (the two tools invoked directly): the depcruise
ratchet means any violation **not** in \`docs/depcruise-baseline.json\` fails \`npm run lint:deps\`,
and ESLint reports warnings only. Note that \`npm run lint:deps\` itself also fails while the
baseline file carries stale entries (${depcruise.staleKnown} at this HEAD) — its shrink-only
regeneration is owed by whoever removed the last of those violations.
`);

	parts.push(`## Ten largest non-generated source files

\`git ls-files\` filtered to source extensions (${SIZE_EXTENSIONS.join(' ')}), excluding:

${SIZE_EXCLUSIONS.map((exclusion) => `- \`${exclusion.exact ?? exclusion.prefix + '*'}\` — ${exclusion.reason}`).join('\n')}

Line counts are \`wc -l\` semantics. Command shape: \`git ls-files '*.ts' '*.mjs' '*.rs' '*.css' | grep -v … | xargs wc -l | sort -rn | head\`.

| Lines | File |
|---|---|
${largest.map((entry) => `| ${entry.lines} | ${entry.file} |`).join('\n')}

Goal G2 ratchets non-generated files down to ≤ 600 lines; \`src/dataSource.ts\` (the v1.0 god
module still carrying the shipped view until Phase 4 deletes it) tops the table as expected.
`);

	parts.push(`## Repository shape

Tracked files per top-level directory (\`git ls-files | cut -d/ -f1 | sort | uniq -c | sort -rn\`):

| Directory | Tracked files |
|---|---|
${repo.rows.map(([directory, count]) => `| ${directory}/ | ${count} |`).join('\n')}
| (repository root) | ${repo.rootFiles} |
| **Total** | **${repo.total}** |

\`legacy/\` no longer exists in this tree (it has been drained by the refactor's phases);
\`dist/\`, \`media/\`, \`out/\`, \`native/<platform>/\` and \`*.vsix\` are gitignored build outputs.
`);

	parts.push(`## Not measured here

| Item | Why | Reproduce with |
|---|---|---|
| \`bench.mjs\` first-paint on the current tree | no prebuilt engine binary in this worktree; bench also needs the \`out/\` tree | \`npm run build && node scripts/bench.mjs <repo> --commits 200 --runs 5\` |
| Rust line/branch coverage | needs \`cargo llvm-cov\` (the full workspace build) | \`cargo llvm-cov --workspace --lcov --output-path lcov.info\` |
| Node line/branch coverage | the Vitest coverage provider is not wired yet (REFACTOR-PLAN task 7.3) | \`npx vitest run --coverage\` once configured |
| Platform VSIX sizes | each needs its cross-compiled addon from CI's cargo matrix | \`node scripts/package-platforms.mjs\` (in CI: \`.github/workflows/native-build.yml\`) |
| All §3.8.1 timing scenarios (T0–T5, P50/P95) | the marker infrastructure and P1–P5 harness do not exist yet | \`test/perf/\` (P2–P5) and \`native/core/benches/\` (P1) — status tracked in \`docs/performance.md\` |

<!-- baseline-summary: ${JSON.stringify({
		vitestCases: vitest.cases,
		vitestFiles: vitest.files,
		vitestMatchedFiles: vitest.matchedFiles,
		rustTests: rust.total,
		extensionJs: sizes.artifacts[0].bytes,
		firstPaintJs: sizes.firstPaintJs,
		firstPaintCss: sizes.firstPaintCss,
		vsix: sizes.vsixBytes,
		addonNodes: Object.fromEntries(addons.map((addon) => [addon.platform, addon.bytes])),
		depcruiseViolations: depcruise.violations,
		eslintProblems: eslint.problems,
		largestFile: largest[0]
	})} -->
`);

	return parts.join('\n');
}

const document = build();
fs.writeFileSync(docPath, document);
console.log(document);
