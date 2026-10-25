/**
 * The run's three reports (§6.8.1, task 0.6): JUnit XML (what CI renders directly), JSON (the
 * machine copy, evidence paths and per-action legacy records included) and HTML (the human
 * summary). All written by the entry into the launcher-chosen results directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { E2eReport, ScenarioRecord } from './types';

/** XML-escape a text node / attribute value. */
function xmlEscape(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Seconds with one decimal (JUnit's time unit). */
function seconds(ms: number | null): string {
	return ((ms ?? 0) / 1000).toFixed(1);
}

/** One <testcase> per scenario (a failing legacy scenario's first action error is the message). */
function junitTestCase(scenario: ScenarioRecord): string {
	const attributes = ' classname="' + xmlEscape(scenario.id) + '" name="' + xmlEscape(scenario.title) + '" time="' + seconds(scenario.durationMs) + '"';
	if (scenario.status === 'pass') {
		return '<testcase' + attributes + '></testcase>';
	}
	if (scenario.status === 'skip') {
		return '<testcase' + attributes + '><skipped message="' + xmlEscape(scenario.detail ?? 'skipped') + '"/></testcase>';
	}
	const body = xmlEscape((scenario.detail ?? 'failed')
		+ (scenario.evidence.length > 0 ? '\n\nevidence:\n' + scenario.evidence.join('\n') : ''));
	return '<testcase' + attributes + '><failure message="' + xmlEscape((scenario.detail ?? 'failed').split('\n')[0]) + '">' + body + '</failure></testcase>';
}

/** The JUnit document: one testsuite, one testcase per scenario. */
export function junitXml(report: E2eReport): string {
	const lines: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<testsuites name="git-graph-rs-e2e-' + xmlEscape(report.options.tier) + '" tests="' + report.totals.scenarios
		+ '" failures="' + report.totals.failed + '" skipped="' + report.totals.skipped
		+ '" time="' + seconds(report.durationMs) + '">',
		'\t<testsuite name="e2e-' + xmlEscape(report.options.tier) + '" tests="' + report.totals.scenarios
		+ '" failures="' + report.totals.failed + '" skipped="' + report.totals.skipped
		+ '" time="' + seconds(report.durationMs) + '" timestamp="' + xmlEscape(report.startedAt) + '">'
	];
	for (const scenario of report.scenarios) {
		lines.push('\t\t' + junitTestCase(scenario));
	}
	lines.push('\t</testsuite>', '</testsuites>');
	return lines.join('\n') + '\n';
}

/** The HTML summary: totals, the environment, one row per scenario. */
export function htmlReport(report: E2eReport): string {
	const row = (scenario: ScenarioRecord): string => {
		const color = scenario.status === 'pass' ? '#1a7f37' : scenario.status === 'skip' ? '#9a6700' : '#cf222e';
		const evidence = scenario.evidence.length > 0
			? ' <span style="color:#888">' + scenario.evidence.map((file) => htmlEscape(file)).join(' · ') + '</span>'
			: '';
		const detail = scenario.detail === null ? '' : ' <span style="color:#666">— ' + htmlEscape(firstLine(scenario.detail)) + '</span>';
		return '<tr><td><code>' + htmlEscape(scenario.id) + '</code></td>'
			+ '<td style="color:' + color + ';font-weight:600">' + scenario.status.toUpperCase() + '</td>'
			+ '<td>' + seconds(scenario.durationMs) + 's' + detail + evidence + '</td></tr>';
	};
	return [
		'<!DOCTYPE html><html><head><meta charset="utf-8"><title>Git Graph RS E2E — ' + htmlEscape(report.options.tier) + '</title></head>',
		'<body style="font:13px/1.5 -apple-system,Segoe UI,sans-serif;max-width:960px;margin:2rem auto">',
		'<h1>Git Graph RS — E2E ' + htmlEscape(report.options.tier) + ' tier</h1>',
		'<p><strong>' + report.totals.passed + ' passed</strong>, ' + report.totals.failed + ' failed, ' + report.totals.skipped + ' skipped'
		+ ' (' + report.totals.scenarios + ' scenarios in ' + seconds(report.durationMs) + 's)</p>',
		'<p style="color:#666">VS Code ' + htmlEscape(report.runtime?.editorVersion ?? '?')
		+ ' · backend ' + htmlEscape(report.runtime?.backend ?? report.options.backend)
		+ ' · lang ' + htmlEscape(report.options.lang)
		+ ' · finished ' + htmlEscape(report.finishedAt) + '</p>',
		'<table style="border-collapse:collapse;width:100%">',
		'<tr style="text-align:left;border-bottom:2px solid #ddd"><th>Scenario</th><th>Status</th><th>Detail</th></tr>',
		...report.scenarios.map(row),
		'</table>',
		'<p style="color:#888;margin-top:2rem">JUnit XML: junit.xml · full data: report.json · evidence: evidence/</p>',
		'</body></html>'
	].join('\n') + '\n';
}

function htmlEscape(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function firstLine(text: string): string {
	const line = text.split('\n')[0];
	return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

/** Write all three reports; returns their paths (JUnit first — what CI wants). */
export function writeReports(report: E2eReport, resultsDir: string): { junit: string; json: string; html: string } {
	fs.mkdirSync(resultsDir, { recursive: true });
	const junit = path.join(resultsDir, 'junit.xml');
	const json = path.join(resultsDir, 'report.json');
	const html = path.join(resultsDir, 'report.html');
	fs.writeFileSync(junit, junitXml(report));
	fs.writeFileSync(json, JSON.stringify(report, null, '\t') + '\n');
	fs.writeFileSync(html, htmlReport(report));
	return { junit, json, html };
}
