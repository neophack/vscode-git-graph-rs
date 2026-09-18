/**
 * Tests for the automation wire protocol (src/automation/protocol.ts): newline-delimited
 * JSON-RPC 2.0 framing. No vscode, no extension host — pure codec plus a real-socket smoke test.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { encodeWireMessage, decodeWireMessages, isRequest } = require(path.join(rootDir, 'out', 'automation', 'protocol.js'));

test('encodeWireMessage produces one line per message', () => {
	const line = encodeWireMessage({ jsonrpc: '2.0', id: 1, method: 'gg.ping' });
	assert.ok(line.endsWith('\n'));
	assert.equal(line.indexOf('\n'), line.length - 1);
	assert.deepEqual(JSON.parse(line), { jsonrpc: '2.0', id: 1, method: 'gg.ping' });
});

test('decodeWireMessages splits multiple messages and keeps the partial line', () => {
	const a = encodeWireMessage({ jsonrpc: '2.0', id: 1, method: 'gg.ping' });
	const b = encodeWireMessage({ jsonrpc: '2.0', id: 2, method: 'gg.status' });
	const decoded = decodeWireMessages(a + b.slice(0, 10));
	assert.equal(decoded.messages.length, 1);
	assert.equal(decoded.messages[0].method, 'gg.ping');
	assert.equal(decoded.rest, b.slice(0, 10));
	assert.deepEqual(decoded.errors, []);
	// The buffered remainder completes on the next chunk.
	const done = decodeWireMessages(decoded.rest + b.slice(10));
	assert.equal(done.messages.length, 1);
	assert.equal(done.messages[0].method, 'gg.status');
	assert.equal(done.rest, '');
});

test('decodeWireMessages tolerates blank lines and reports bad ones', () => {
	const decoded = decodeWireMessages('\nnot json\n{"jsonrpc":"2.0","id":5,"method":"gg.ping"}\n42\n{"noJsonrpc":true}\n');
	assert.equal(decoded.messages.length, 1);
	assert.equal(decoded.errors.length, 3);
	assert.equal(decoded.errors[0].line, 'not json');
	assert.equal(decoded.errors[2].line, '{"noJsonrpc":true}');
});

test('isRequest distinguishes requests from responses and notifications', () => {
	assert.ok(isRequest({ jsonrpc: '2.0', id: 1, method: 'gg.ping' }));
	assert.ok(!isRequest({ jsonrpc: '2.0', id: 1, result: {} }));
	assert.ok(!isRequest({ jsonrpc: '2.0', method: 'gg.traffic', params: {} }));
});

test('framing survives real socket chunking', async () => {
	const server = net.createServer((socket) => {
		socket.setEncoding('utf8');
		let buffer = '';
		socket.on('data', (chunk) => {
			const decoded = decodeWireMessages(buffer + chunk);
			buffer = decoded.rest;
			for (const message of decoded.messages) {
				socket.write(encodeWireMessage({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } }));
			}
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	try {
		const received = [];
		const socket = net.createConnection({ host: '127.0.0.1', port });
		socket.setEncoding('utf8');
		let buffer = '';
		socket.on('data', (chunk) => {
			const decoded = decodeWireMessages(buffer + chunk);
			buffer = decoded.rest;
			received.push(...decoded.messages);
		});
		await new Promise((resolve, reject) => { socket.on('connect', resolve); socket.on('error', reject); });
		// Fire both requests in one write: the server must frame them independently.
		socket.write(
			encodeWireMessage({ jsonrpc: '2.0', id: 1, method: 'gg.ping' })
			+ encodeWireMessage({ jsonrpc: '2.0', id: 2, method: 'gg.status' })
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(received.map((m) => m.result.echoed), ['gg.ping', 'gg.status']);
		socket.destroy();
	} finally {
		server.close();
	}
});
