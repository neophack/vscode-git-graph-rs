/**
 * The host↔webview protocol of the binary comparison area: the hex and
 * picture comparison shared by the standalone Binary Compare tab and the Commit Comparison View's
 * embedded diff area.
 *
 * This is a mechanical typing layer over the messages the host responders
 * (`extension/views/binaryCompare/`) and the webview script exchange — the command names and
 * payload shapes are unchanged. One pair is the boot handshake: the `ready` / `init` pair,
 * which replaces data baked into the page's inline script (no inline scripts are
 * served, so the file's nature - hex or picture - arrives as a message).
 */

/** One rendered hex row as it travels the wire: both sides' offsets (-1 when absent), up-to-16
 *  bytes per side as base64, and per-byte masks ('0' equal, '1' changed). */
export interface HexRowData {
	readonly o: number;
	readonly n: number;
	readonly ob: string;
	readonly nb: string;
	readonly om: string;
	readonly nm: string;
}

/** The section layout flattened for the wire: [oldStart, oldLength, newStart, newLength, equal?]
 *  repeated, or NULL before the background scan has produced a layout. */
export type HexSectionLayout = ReadonlyArray<number> | null;

/** The boot signal of an extracted frontend: the page's script has loaded and is listening. */
export interface BinaryCompareReadyRequest {
	readonly command: 'ready';
}

/** The boot data of the standalone Binary Compare page: which of its two views to enter. */
export interface BinaryCompareInitResponse {
	readonly command: 'init';
	/** Whether the compared file is one the picture view can render (false: the hex view). */
	readonly isImage: boolean;
	/** The interface language the host rendered the page for ('en' or 'zh-cn'). */
	readonly language: string;
}

export interface GetHexInfoRequest {
	readonly command: 'getHexInfo';
	readonly index: number;
	readonly bytesPerRow: number;
}

export interface GetHexRowsRequest {
	readonly command: 'getHexRows';
	readonly index: number;
	readonly start: number;
	readonly count: number;
}

export interface GetImageDataRequest {
	readonly command: 'getImageData';
	readonly index: number;
}

export interface CopyToClipboardRequest {
	readonly command: 'copyToClipboard';
	/** What is being copied ('Hex Bytes' or 'Address'); echoed back by the response. */
	readonly type: string;
	readonly data: string;
}

/** Every message the binary comparison area sends to the extension host. */
export type BinaryCompareRequest =
	| BinaryCompareReadyRequest
	| GetHexInfoRequest
	| GetHexRowsRequest
	| GetImageDataRequest
	| CopyToClipboardRequest;

export interface HexInfoResponse {
	readonly command: 'hexInfo';
	readonly index: number;
	readonly error: string | null;
	readonly oldSize: number;
	readonly newSize: number;
	readonly totalRows: number;
	readonly sections: HexSectionLayout;
	readonly layoutVersion: number;
	readonly bytesPerRow: number;
	readonly rowHeight: number;
}

export interface HexMapResponse {
	readonly command: 'hexMap';
	readonly index: number;
	readonly sections: HexSectionLayout;
	readonly totalRows: number;
	readonly layoutVersion: number;
	readonly error: string | null;
}

export interface HexRowsResponse {
	readonly command: 'hexRows';
	readonly index: number;
	readonly start: number;
	readonly rows: ReadonlyArray<HexRowData>;
	readonly layoutVersion: number;
	readonly error: string | null;
}

export interface ImageDataResponse {
	readonly command: 'imageData';
	readonly index: number;
	readonly error: string | null;
	/** Both sides as data URLs, or NULL for a side that does not exist. */
	readonly oldData: string | null;
	readonly newData: string | null;
	readonly oldSize: number;
	readonly newSize: number;
}

export interface CopyToClipboardResponse {
	readonly command: 'copyToClipboard';
	readonly type: string;
	readonly error: string | null;
}

/** Every message the extension host sends to the binary comparison area. */
export type BinaryCompareResponse =
	| BinaryCompareInitResponse
	| HexInfoResponse
	| HexMapResponse
	| HexRowsResponse
	| ImageDataResponse
	| CopyToClipboardResponse;
