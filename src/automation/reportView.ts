import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SuiteReport } from './suiteRunner';

/**
 * The Automation Test report page: a self-contained webview panel the suite run opens when it
 * finishes. Summary cards, per-suite tables with a filter, and Save buttons that write the
 * report (as interactive HTML or raw JSON) through the platform save dialog.
 */

function esc(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusBadge(run: SuiteReport['suites'][0]['runs'][0]): string {
	if (run.ok) return '<span class="badge pass">PASS</span>';
	if (run.skipped) return '<span class="badge skip">SKIP</span>';
	return '<span class="badge fail">FAIL</span>';
}

function suiteTable(suite: SuiteReport['suites'][0]): string {
	const rows = suite.runs.map((run) => `
		<tr data-search="${esc((run.id + ' ' + run.title + ' ' + run.group).toLowerCase())}">
			<td class="id">${esc(run.id)}</td>
			<td>${esc(run.title)}</td>
			<td class="num">${run.totalMs === null ? '—' : run.totalMs.toFixed(1)}</td>
			<td>${statusBadge(run)}</td>
			<td class="detail">${esc(run.reason ?? run.error ?? '')}</td>
		</tr>`).join('');
	return `
		<section>
			<h2>${suite.name === 'read' ? 'Read suite' : 'Write suite'} <span class="count">${suite.runs.length} actions</span></h2>
			<table>
				<thead><tr><th>Action</th><th>Control</th><th>ms</th><th>Status</th><th>Detail</th></tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</section>`;
}

/** Render the report as a standalone interactive HTML document (also what "Save HTML" writes). */
export function renderReportHtml(report: SuiteReport): string {
	const t = report.totals;
	const skippedNote = report.writeSuiteIncluded
		? ''
		: '<p class="note">The write suite was not run: this repository already has commits and is not a fixture clone, so the runner left it untouched. Point the view at an empty repository (a fresh <code>git init</code> with no commits) to have the runner generate the fixture history into it and exercise the write suite, or open a clone built by <code>scripts/automation/fixture.mjs</code>.</p>';
	const generatedNote = report.fixtureGenerated
		? '<p class="note">The repository had no commits, so the fixture history (2000+ commits) was generated into it before the run.</p>'
		: '';
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-report';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Git Graph Automation Report</title>
<style>
	:root { color-scheme: light dark; }
	body { font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; padding: 0 20px 30px; color: var(--vscode-foreground, #ddd); background: var(--vscode-editor-background, #1e1e1e); }
	h1 { font-size: 18px; margin: 18px 0 4px; }
	h2 { font-size: 14px; margin: 22px 0 8px; }
	.meta { color: var(--vscode-descriptionForeground, #999); margin-bottom: 14px; }
	.meta code { user-select: text; }
	.cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0 6px; }
	.card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; padding: 10px 16px; min-width: 90px; text-align: center; }
	.card .n { font-size: 22px; font-weight: 600; }
	.card .l { font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
	.card.pass .n { color: #4ec9b0; } .card.fail .n { color: #f48771; } .card.skip .n { color: #dcdcaa; }
	.bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; margin: 10px 0 4px; background: var(--vscode-panel-border, #444); }
	.bar i { display: block; height: 100%; } .bar .p { background: #4ec9b0; } .bar .f { background: #f48771; } .bar .s { background: #dcdcaa; }
	.toolbar { display: flex; gap: 8px; align-items: center; margin: 14px 0 4px; }
	button { font: inherit; color: inherit; background: var(--vscode-button-background, #0e639c); border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer; }
	button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); }
	input[type="search"] { font: inherit; color: inherit; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, #444); border-radius: 4px; padding: 5px 10px; min-width: 260px; }
	table { border-collapse: collapse; width: 100%; margin-top: 6px; }
	th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); vertical-align: top; }
	th { color: var(--vscode-descriptionForeground, #999); font-weight: 500; }
	td.id { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: nowrap; }
	td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
	td.detail { color: var(--vscode-descriptionForeground, #999); }
	.badge { border-radius: 4px; padding: 1px 7px; font-size: 11px; }
	.badge.pass { background: rgba(78, 201, 176, .15); color: #4ec9b0; }
	.badge.fail { background: rgba(244, 135, 113, .15); color: #f48771; }
	.badge.skip { background: rgba(220, 220, 170, .15); color: #dcdcaa; }
	.note { color: var(--vscode-descriptionForeground, #999); border-left: 3px solid var(--vscode-panel-border, #444); padding-left: 10px; max-width: 70em; }
	.empty { color: var(--vscode-descriptionForeground, #999); margin-top: 8px; }
	.count { font-weight: normal; font-size: 12px; color: var(--vscode-descriptionForeground, #999); }
</style>
</head>
<body>
	<h1>Git Graph Automation Report</h1>
	<div class="meta">
		Repository: <code>${esc(report.repo)}</code>${report.fixture ? ' (fixture clone)' : ''}<br>
		Started ${esc(report.startedAt)} &middot; finished ${esc(report.finishedAt)} &middot; ${(report.durationMs / 1000).toFixed(1)} s
	</div>
	<div class="cards">
		<div class="card"><div class="n">${t.actions}</div><div class="l">actions</div></div>
		<div class="card pass"><div class="n">${t.passed}</div><div class="l">passed</div></div>
		<div class="card fail"><div class="n">${t.failed}</div><div class="l">failed</div></div>
		<div class="card skip"><div class="n">${t.skipped}</div><div class="l">skipped</div></div>
	</div>
	<div class="bar">
		${t.passed > 0 ? `<i class="p" style="width:${(100 * t.passed / Math.max(1, t.actions)).toFixed(2)}%"></i>` : ''}
		${t.failed > 0 ? `<i class="f" style="width:${(100 * t.failed / Math.max(1, t.actions)).toFixed(2)}%"></i>` : ''}
		${t.skipped > 0 ? `<i class="s" style="width:${(100 * t.skipped / Math.max(1, t.actions)).toFixed(2)}%"></i>` : ''}
	</div>
	<div class="toolbar">
		<input id="filter" type="search" placeholder="Filter by id, title or group…">
		<span id="shown" class="count"></span>
		<span style="flex:1"></span>
		<button class="secondary" id="saveHtml">Save as HTML…</button>
		<button class="secondary" id="saveJson">Save as JSON…</button>
	</div>
	${generatedNote}${skippedNote}
	${report.suites.map(suiteTable).join('')}
	${t.actions === 0 ? '<p class="empty">No actions ran (the catalog filter matched nothing).</p>' : ''}
	<script nonce="report">
		(function () {
			var vscode = acquireVsCodeApi();
			document.getElementById('saveHtml').addEventListener('click', function () { vscode.postMessage({ command: 'saveReport', format: 'html' }); });
			document.getElementById('saveJson').addEventListener('click', function () { vscode.postMessage({ command: 'saveReport', format: 'json' }); });
			var rows = Array.prototype.slice.call(document.querySelectorAll('tbody tr'));
			var shown = document.getElementById('shown');
			function apply() {
				var q = document.getElementById('filter').value.trim().toLowerCase();
				var n = 0;
				rows.forEach(function (row) {
					var hit = q === '' || row.getAttribute('data-search').indexOf(q) !== -1;
					row.style.display = hit ? '' : 'none';
					if (hit) n++;
				});
				shown.textContent = q === '' ? '' : n + ' of ' + rows.length + ' shown';
			}
			document.getElementById('filter').addEventListener('input', apply);
			apply();
		})();
	</script>
</body>
</html>`;
}

/** Open the report in a new webview panel; wires the Save buttons to the platform save dialog. */
export function showAutomationReport(report: SuiteReport): void {
	const panel = vscode.window.createWebviewPanel(
		'git-graph-rs-automation-report',
		'Automation Report',
		vscode.ViewColumn.Beside,
		{ enableScripts: true, retainContextWhenHidden: true }
	);
	panel.webview.html = renderReportHtml(report);
	panel.webview.onDidReceiveMessage((message: { command?: string; format?: 'html' | 'json' }) => {
		if (message.command !== 'saveReport') return;
		const stamp = report.finishedAt.replace(/[:.]/g, '-');
		const extension = message.format === 'json' ? 'json' : 'html';
		vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(path.join('git-graph-automation-report-' + stamp + '.' + extension)),
			filters: extension === 'json' ? { JSON: ['json'] } : { HTML: ['html'] }
		}).then((uri) => {
			if (uri === undefined) return;
			const content = message.format === 'json'
				? JSON.stringify(report, null, 2) + '\n'
				: renderReportHtml(report);
			fs.writeFile(uri.fsPath, content, (error) => {
				if (error !== null) {
					void vscode.window.showErrorMessage('Unable to save the automation report: ' + error.message);
				} else {
					void vscode.window.showInformationMessage('Automation report saved to ' + uri.fsPath);
				}
			});
		});
	});
}
