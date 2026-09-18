/**
 * The wire contract between the automation server (running inside the extension host) and an
 * external test driver. One JSON-RPC 2.0 message per line (newline-delimited JSON over TCP),
 * so a driver can be written with nothing more than a socket and JSON. All `gg.*` methods and
 * the notification shapes are documented in the "Remote automation & debugging" README section.
 */

/** A JSON-RPC 2.0 request sent by the driver. */
export interface AutomationRequest {
	readonly jsonrpc: '2.0';
	readonly id: number | string;
	readonly method: string;
	readonly params?: unknown;
}

/** A JSON-RPC 2.0 response sent by the server. The id may be NULL for errors that cannot be correlated (e.g. a malformed line from the driver). */
export interface AutomationResponse {
	readonly jsonrpc: '2.0';
	readonly id: number | string | null;
	readonly result?: unknown;
	readonly error?: AutomationError;
}

/** A JSON-RPC 2.0 notification (either direction; notifications never carry an id). */
export interface AutomationNotification {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: unknown;
}

export interface AutomationError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

/* Standard JSON-RPC 2.0 error codes. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/* Server-specific error codes (the JSON-RPC reserved range for implementation-defined errors). */
export const ERR_SERVER_GONE = -32000;
export const ERR_NO_VIEW = -32001; // no Git Graph view is open (call gg.openView first)
export const ERR_BUSY = -32002; // a gg.run is already in progress
export const ERR_RUN_TIMEOUT = -32003; // the action's expected responses did not all arrive
export const ERR_CLIENT_REJECTED = -32004; // only one driver connection is accepted at a time
export const ERR_ACTION_FAILED = -32005; // the action ran but its verification did not pass

export const PROTOCOL_VERSION = 1;

/** Every message travelling the socket, framed as one JSON value per line. */
export type AutomationWireMessage = AutomationRequest | AutomationResponse | AutomationNotification;

export function isRequest(msg: AutomationWireMessage): msg is AutomationRequest {
	return typeof (msg as AutomationRequest).method === 'string' && (msg as AutomationRequest).id !== undefined;
}

export function encodeWireMessage(msg: AutomationWireMessage): string {
	return JSON.stringify(msg) + '\n';
}

export interface DecodedMessages {
	/** Messages successfully parsed from complete lines. */
	readonly messages: AutomationWireMessage[];
	/** Parse errors for lines that were not valid JSON (or not JSON-RPC shaped), in line order. */
	readonly errors: { readonly line: string; readonly error: string }[];
	/** The trailing partial line, to be prepended to the next chunk. */
	readonly rest: string;
}

/**
 * Decode as many newline-terminated lines of the buffer as possible. Lines that fail to parse
 * are reported as errors and consumed (the connection stays up — a test driver must not be able
 * to wedge the server by sending a bad line), and any trailing partial line is returned to be
 * prepended to the next chunk.
 */
export function decodeWireMessages(buffer: string): DecodedMessages {
	const messages: AutomationWireMessage[] = [];
	const errors: { line: string; error: string }[] = [];
	let rest = '';
	let start = 0;
	for (let i = 0; i < buffer.length; i++) {
		if (buffer.charCodeAt(i) !== 10) continue; // '\n'
		const line = buffer.slice(start, i);
		start = i + 1;
		if (line.trim() === '') continue;
		try {
			const parsed = JSON.parse(line) as AutomationWireMessage;
			if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { jsonrpc?: unknown }).jsonrpc !== 'string') {
				errors.push({ line, error: 'not a JSON-RPC 2.0 message' });
			} else {
				messages.push(parsed);
			}
		} catch (e) {
			errors.push({ line, error: e instanceof Error ? e.message : String(e) });
		}
	}
	rest = buffer.slice(start);
	return { messages, errors, rest };
}
