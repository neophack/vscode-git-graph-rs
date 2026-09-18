/**
 * Integration test for the automation server over a real socket, against the REAL extension
 * pipeline (real GitGraphView + real compiled webview in jsdom, booted by
 * webviewRealPipelineHarness): ping/status/catalog/query/invoke/eval, catalog runs in both
 * request and UI mode (the UI mode round-trips through the in-page shim), stats, and the
 * connection/error contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bootRealView, createRepo, sleep } from './webviewRealPipelineHarness.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* A newline-delimited JSON-RPC client over a raw socket (independent of scripts/automation,
 * so the test keeps working when only out/ is built). */
function connectClient(port) {
	const socket = net.createConnection({ host: '127.0.0.1', port });
	socket.setEncoding('utf8');
	let buffer = '';
	let nextId = 1;
	const pending = new Map();
	const notifications = [];
	const ready = new Promise((resolve, reject) => {
		socket.on('connect', resolve);
		socket.on('error', reject);
	});
	socket.on('data', (chunk) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim() === '') continue;
			const message = JSON.parse(line);
			if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
				const { resolve, reject } = pending.get(message.id);
				pending.delete(message.id);
				if (message.error !== undefined) {
					const error = new Error(message.error.message);
					error.code = message.error.code;
					reject(error);
				} else {
					resolve(message.result);
				}
			} else if (message.method !== undefined) {
				notifications.push(message);
			}
		}
	});
	return {
		ready,
		notifications,
		async call(method, params) {
			await ready;
			const id = nextId++;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
			});
		},
		close() { socket.destroy(); }
	};
}

const repo = path.join(os.tmpdir(), 'gg-automation-server-test');
let boot, server, client;

// Minimal logger: the assertions here read protocol results, not log lines.
const silentLogger = { log() { }, logError() { } };

test.before(async () => {
	createRepo(repo);
	boot = await bootRealView(repo);
	await sleep(500); // let the initial page load settle
	server = new boot.automation.AutomationServer({ logger: silentLogger, bridge: new boot.automation.HostBridge(), version: 'test' });
	await server.start(0);
	client = connectClient(server.port);
	await client.ready;
});

test.after(async () => {
	client?.close();
	server?.stop();
	boot?.dispose();
	fs.rmSync(repo, { recursive: true, force: true });
});

test('gg.ping answers with the extension identity', async () => {
	const result = await client.call('gg.ping');
	assert.equal(result.pong, true);
	assert.equal(result.extension, 'git-graph-rs');
	assert.equal(result.version, 'test');
});

test('gg.status reports the loaded view and repository', async () => {
	const status = await client.call('gg.status');
	assert.equal(status.viewLoaded, true);
	const normalise = (p) => p.replace(/\\/g, '/');
	assert.equal(normalise(status.currentRepo), normalise(repo));
	assert.ok(status.repos.map(normalise).includes(normalise(repo)));
});

test('gg.catalog lists the control-bar refresh action', async () => {
	const catalog = await client.call('gg.catalog');
	assert.ok(Array.isArray(catalog.actions));
	const refresh = catalog.actions.find((a) => a.id === 'control-bar/refresh');
	assert.ok(refresh, 'control-bar/refresh must be in the catalog');
	assert.ok(refresh.ui.length > 0 && refresh.request.length > 0);
});

test('gg.query repoInfo reads through the real pipeline', async () => {
	const repoInfo = await client.call('gg.query', { kind: 'repoInfo' });
	assert.equal(repoInfo.command, 'loadRepoInfo');
	assert.equal(repoInfo.head, 'main');
	assert.ok(repoInfo.branches.includes('main'));
});

test('gg.invoke returns the response payload', async () => {
	const outcome = await client.call('gg.invoke', {
		message: { command: 'loadRepoInfo', repo, refreshId: 0, showRemoteBranches: true, showStashes: true, hideRemotes: [] }
	});
	assert.equal(outcome.ok, true);
	assert.equal(outcome.response.head, 'main');
	assert.ok(outcome.timings.totalMs >= 0);
});

test('gg.run refresh in request mode times the host round trip', async () => {
	const outcome = await client.call('gg.run', { id: 'control-bar/refresh', mode: 'request' });
	assert.equal(outcome.ok, true, outcome.error);
	assert.ok(outcome.timings.totalMs > 0);
	const commands = outcome.timings.responses.map((r) => r.command);
	assert.ok(commands.includes('loadRepoInfo'));
	assert.ok(commands.includes('loadCommits'));
});

test('gg.run refresh in UI mode drives the real webview button', async () => {
	const outcome = await client.call('gg.run', { id: 'control-bar/refresh', mode: 'ui' });
	assert.equal(outcome.ok, true, outcome.error);
	assert.ok(outcome.timings.totalMs > 0);
	assert.deepEqual(outcome.timings.responses.map((r) => r.command), ['loadRepoInfo', 'loadCommits']);
});

test('gg.eval executes in the page and returns the value', async () => {
	const outcome = await client.call('gg.eval', { expr: '({ rows: document.querySelectorAll("#commitTable tr.commit").length })' });
	assert.equal(outcome.ok, true, outcome.error);
	assert.ok(outcome.value.rows > 0);
});

test('gg.stats aggregates the runs', async () => {
	const stats = await client.call('gg.stats');
	const refreshUi = stats.find((s) => s.id === 'control-bar/refresh' && s.mode === 'ui');
	assert.ok(refreshUi, 'stats must contain control-bar/refresh ui');
	assert.ok(refreshUi.runs >= 1);
	assert.ok(refreshUi.p50Ms >= refreshUi.minMs && refreshUi.p50Ms <= refreshUi.maxMs);
});

test('unknown methods and unknown actions are rejected', async () => {
	await assert.rejects(() => client.call('gg.nope'), (error) => error.code === -32601);
	await assert.rejects(() => client.call('gg.run', { id: 'control-bar/does-not-exist' }), (error) => error.code === -32602);
});

test('a second driver connection is rejected', async () => {
	let seen = null;
	const socket = net.createConnection({ host: '127.0.0.1', port: server.port });
	socket.setEncoding('utf8');
	const parsed = new Promise((resolve) => {
		socket.on('data', (chunk) => {
			for (const line of String(chunk).split('\n')) {
				if (line.trim() === '') continue;
				const message = JSON.parse(line);
				if (message.error !== undefined) { seen = message.error; resolve(); }
			}
		});
	});
	await new Promise((resolve, reject) => { socket.on('connect', resolve); socket.on('error', reject); });
	await Promise.race([parsed, sleep(3000)]);
	assert.ok(seen !== null, 'the second connection must receive an error');
	assert.equal(seen.code, -32004);
	socket.destroy();
});
