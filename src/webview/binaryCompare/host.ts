/**
 * The host connection of the two extracted comparison frontends (task 6.1), following the sole
 * acquireVsCodeApi holder pattern of common/host/bridge.ts: the handle is acquired once and
 * published on window.__ggVscodeApi, so any other script in the page (an automation shim) reuses
 * it instead of hitting VS Code's once-only guard.
 *
 * The common bridge is typed over the main graph view's protocol; these pages speak the
 * comparison / binary-compare protocols, so each view gets this small typed wrapper over the same
 * shared handle.
 */

import type { BinaryCompareRequest, BinaryCompareResponse } from '../../shared/protocol/binaryCompare';
import type { ComparisonRequest, ComparisonResponse } from '../../shared/protocol/comparison';

/** The VS Code webview API handle. */
interface VsCodeApi {
	getState(): unknown;
	setState(state: unknown): void;
	postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface BridgeWindow extends Window {
	__ggVscodeApi?: VsCodeApi;
}

function sharedApi(): VsCodeApi {
	const win = <BridgeWindow>window;
	const api = win.__ggVscodeApi !== undefined ? win.__ggVscodeApi : acquireVsCodeApi();
	win.__ggVscodeApi = api;
	return api;
}

/** The connection of the binary compare page: the hex/picture protocol. */
export class BinaryCompareBridge {
	private readonly api: VsCodeApi;

	constructor() {
		this.api = sharedApi();
	}

	/** Send a request to the extension host. */
	public send(message: BinaryCompareRequest) {
		this.api.postMessage(message);
	}

	/** Listen to the responses of the extension host. */
	public onMessage(handler: (message: BinaryCompareResponse) => void) {
		window.addEventListener('message', (event) => handler(<BinaryCompareResponse>event.data));
	}
}

/** The connection of the comparison page: the comparison protocol over the same handle. */
export class ComparisonBridge {
	private readonly api: VsCodeApi;

	constructor() {
		this.api = sharedApi();
	}

	/** Send a request to the extension host. */
	public send(message: ComparisonRequest) {
		this.api.postMessage(message);
	}

	/** Listen to the responses of the extension host. */
	public onMessage(handler: (message: ComparisonResponse) => void) {
		window.addEventListener('message', (event) => handler(<ComparisonResponse>event.data));
	}

	/** The persisted state of this webview (the sidebar width), or NULL. */
	public getState<T>(): T | null {
		return <T | null>this.api.getState();
	}

	/** Persist the state of this webview. */
	public setState(state: unknown) {
		this.api.setState(state);
	}
}
