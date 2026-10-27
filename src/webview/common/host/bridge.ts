/**
 * The HostBridge: the webview's only connection to the extension host.
 * It is the sole caller of `acquireVsCodeApi`, and every request goes through `send`, typed
 * against the protocol's RequestMessage union.
 *
 * VS Code allows acquireVsCodeApi() to be called only once per webview. The automation shim
 * (inlined into the page before this bundle in automation builds) posts its results through the
 * shared `window.__ggVscodeApi` handle instead of acquiring its own: whichever of the two
 * acquires first publishes the instance there, so the other can never hit the once-only guard.
 */

import * as GG from '../protocol';

/** The persisted state of a webview (restored by VS Code after the webview is reloaded). */
export interface VsCodeApi<State> {
	getState(): State | null;
	postMessage(message: GG.RequestMessage): void;
	setState(state: State): void;
}

declare function acquireVsCodeApi(): VsCodeApi<unknown>;

interface BridgeWindow extends Window {
	__ggVscodeApi?: VsCodeApi<unknown>;
}

export class HostBridge<State> {
	private readonly api: VsCodeApi<State>;

	constructor() {
		const win = <BridgeWindow>window;
		const api = win.__ggVscodeApi !== undefined ? win.__ggVscodeApi : acquireVsCodeApi();
		win.__ggVscodeApi = api;
		this.api = <VsCodeApi<State>>api;
	}

	/** Send a request to the extension host. */
	public send(message: GG.RequestMessage) {
		this.api.postMessage(message);
	}

	/**
	 * Listen to the responses of the extension host.
	 * @param handler Invoked with every response.
	 */
	public onMessage(handler: (message: GG.ResponseMessage) => void) {
		window.addEventListener('message', (event) => handler(<GG.ResponseMessage>event.data));
	}

	/** The state VS Code persisted for this webview, or NULL. */
	public getState(): State | null {
		return this.api.getState();
	}

	/** Persist the state of this webview. */
	public setState(state: State) {
		this.api.setState(state);
	}
}
