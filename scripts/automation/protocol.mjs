/**
 * Minimal newline-delimited JSON-RPC 2.0 client for the automation server (the TCP server
 * inside the extension host, speaking one JSON message per line — see src/automation/protocol.ts).
 * Zero dependencies: one net.Socket, a line buffer, and an incrementing request id.
 *
 *   const client = await connect({ port: 4711 });
 *   const pong = await client.call('gg.ping');
 *   client.onNotify('gg.traffic', (params) => { ... });
 *   client.close();
 */

import net from 'node:net';

/**
 * Connect to the automation server.
 * @param {{host?: string, port: number, timeoutMs?: number}} options
 * @returns {Promise<{call: Function, onNotify: Function, close: Function}>}
 */
export function connect({ host = '127.0.0.1', port, timeoutMs = 10000 } = {}) {
	if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
		return Promise.reject(new Error('connect requires a positive integer port'));
	}
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host, port });
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(new Error('Timed out after ' + timeoutMs + ' ms connecting to ' + host + ':' + port));
		}, timeoutMs);
		socket.once('error', (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		socket.once('connect', () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.setEncoding('utf8');
			resolve(createClient(socket, timeoutMs));
		});
	});
}

function createClient(socket, defaultTimeoutMs) {
	let nextId = 1;
	let lineBuffer = '';
	/** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout|null}>} */
	const pending = new Map();
	/** @type {Map<string, Set<Function>>} */
	const notifyHandlers = new Map();

	socket.on('data', (chunk) => {
		lineBuffer += chunk;
		let newline = lineBuffer.indexOf('\n');
		while (newline !== -1) {
			const line = lineBuffer.slice(0, newline);
			lineBuffer = lineBuffer.slice(newline + 1);
			if (line.trim() !== '') {
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					message = null; // an unparseable line is dropped, the connection stays up
				}
				if (message !== null) handleMessage(message);
			}
			newline = lineBuffer.indexOf('\n');
		}
	});

	socket.on('close', () => {
		lineBuffer = '';
		for (const [id, entry] of pending) {
			if (entry.timer !== null) clearTimeout(entry.timer);
			entry.reject(new Error('Connection closed while waiting for a response to request ' + id));
		}
		pending.clear();
	});

	socket.on('error', () => { /* 'close' follows; the pending calls are rejected there */ });

	function handleMessage(message) {
		if (typeof message !== 'object' || message === null) return;
		if (message.id !== undefined && typeof message.method !== 'string') {
			// A response to one of our requests.
			const entry = pending.get(message.id);
			if (entry === undefined) return; // unknown id: not ours, log nothing
			pending.delete(message.id);
			if (entry.timer !== null) clearTimeout(entry.timer);
			if (message.error !== undefined) {
				const error = new Error(
					typeof message.error.message === 'string' ? message.error.message : 'JSON-RPC error');
				error.code = typeof message.error.code === 'number' ? message.error.code : -32000;
				entry.reject(error);
			} else {
				entry.resolve(message.result);
			}
			return;
		}
		if (typeof message.method === 'string' && message.id === undefined) {
			// A notification (gg.traffic and friends).
			const callbacks = notifyHandlers.get(message.method);
			if (callbacks !== undefined) {
				for (const callback of callbacks) callback(message.params);
			}
			return;
		}
		// Requests from the server are not part of the contract: ignored.
	}

	/**
	 * Call a JSON-RPC method. Rejects with an Error carrying .code/.message on a JSON-RPC error.
	 * @param {string} method
	 * @param {unknown} [params]
	 * @param {number} [callTimeoutMs] per-call timeout override (defaults to the connect timeout)
	 */
	function call(method, params, callTimeoutMs = defaultTimeoutMs) {
		return new Promise((resolve, reject) => {
			if (socket.destroyed) {
				reject(new Error('Connection to the automation server is closed'));
				return;
			}
			const id = nextId++;
			let timer = null;
			if (callTimeoutMs > 0) {
				timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error('Timed out after ' + callTimeoutMs + ' ms waiting for ' + method));
				}, callTimeoutMs);
			}
			pending.set(id, { resolve, reject, timer });
			const message = params === undefined
				? { jsonrpc: '2.0', id, method }
				: { jsonrpc: '2.0', id, method, params };
			socket.write(JSON.stringify(message) + '\n');
		});
	}

	/** Subscribe to a notification method; returns an unsubscribe function. */
	function onNotify(method, callback) {
		let callbacks = notifyHandlers.get(method);
		if (callbacks === undefined) {
			callbacks = new Set();
			notifyHandlers.set(method, callbacks);
		}
		callbacks.add(callback);
		return () => callbacks.delete(callback);
	}

	function close() {
		socket.destroy();
	}

	return { call, onNotify, close };
}
