import { GitStreamSpawner, HEX_BYTES_PER_ROW, HEX_ROW_HEIGHT, HexDiffSession, HexSection } from './hexDiff';
import { t } from '../../../i18n';
import { BinaryCompareResponse } from '../../../shared/protocol/binaryCompare';
import { GitFileChange } from '../../../types';
import { UNCOMMITTED } from '../../../utils/git';
import { copyToClipboard } from '../../../utils/actions';

/**
 * Everything the two binary comparison surfaces share: the Commit Comparison View's embedded
 * diff area, and the standalone Binary Compare tab. The host-side responders below drive a
 * HexDiffSession over the `hexInfo` / `hexMap` / `hexRows` / `imageData` messages of
 * shared/protocol/binaryCompare, which either page's frontend consumes.
 */

/** A page's way of posting a message back to its webview. */
export type BinaryComparePost = (message: BinaryCompareResponse) => void;

/** The section layout flattened for the webview: [oldStart, oldLength, newStart, newLength, equal?] repeated. */
export function flatSections(sections: ReadonlyArray<HexSection> | null): number[] | null {
	if (sections === null) return null;
	const flat: number[] = [];
	for (const section of sections) flat.push(section.os, section.ol, section.ns, section.nl, section.eq ? 1 : 0);
	return flat;
}

/** The image types the comparison view renders in picture mode, mapped to their MIME types. */
const IMAGE_MIME: { [extension: string]: string } = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
	bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml'
};

/**
 * The largest image side handed to the webview as a single data URL (decoding a few tens of MB
 * in the webview is fine; anything bigger stays in the hex view, which is size-independent).
 */
const IMAGE_SIZE_LIMIT = 32 * 1024 * 1024;

export function imageMimeOf(filePath: string): string | null {
	const dot = filePath.lastIndexOf('.');
	const extension = dot >= 0 ? filePath.substring(dot + 1).toLowerCase() : '';
	return Object.prototype.hasOwnProperty.call(IMAGE_MIME, extension) ? IMAGE_MIME[extension] : null;
}

/**
 * The session comparing one file between two revisions. `fromHash`/`toHash` treat
 * UNCOMMITTED and '' as the working tree, exactly like the diff the view is showing.
 */
export function createHexSession(spawner: GitStreamSpawner, repo: string, fromHash: string, toHash: string, file: GitFileChange): HexDiffSession {
	const fromWorkingTree = fromHash === UNCOMMITTED || fromHash === '';
	const toWorkingTree = toHash === UNCOMMITTED || toHash === '';
	return new HexDiffSession(spawner, repo,
		fromWorkingTree, file.oldFilePath !== '' ? file.oldFilePath : file.newFilePath, fromHash,
		toWorkingTree, file.newFilePath !== '' ? file.newFilePath : file.oldFilePath, toHash,
		file);
}

/** Forward the session's background scan result into a page as a `hexMap` message. */
export function wireHexSession(session: HexDiffSession, index: number, post: BinaryComparePost): void {
	session.onSections = (sections, error) => {
		post({ command: 'hexMap', index: index, sections: flatSections(sections), totalRows: session.totalRows, layoutVersion: session.layoutVersion, error: error });
	};
}

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** Answer a page's `getHexInfo`: apply the row width it measured, resolve sizes, reply. */
export async function respondHexInfo(session: HexDiffSession, index: number, bytesPerRow: number, post: BinaryComparePost): Promise<void> {
	try {
		session.setBytesPerRow(bytesPerRow);
		await session.init();
		post({ command: 'hexInfo', index: index, error: null, oldSize: session.oldSize, newSize: session.newSize, totalRows: session.totalRows, sections: flatSections(session.sectionLayout), layoutVersion: session.layoutVersion, bytesPerRow: session.bytesPerRow, rowHeight: HEX_ROW_HEIGHT });
	} catch (err) {
		post({ command: 'hexInfo', index: index, error: t('compareHexLoadError', errorMessage(err)), oldSize: -1, newSize: -1, totalRows: 0, sections: null, layoutVersion: 0, bytesPerRow: HEX_BYTES_PER_ROW, rowHeight: HEX_ROW_HEIGHT });
	}
}

/** Answer a page's `getHexRows`: the rows of one visible window. */
export async function respondHexRows(session: HexDiffSession, index: number, start: number, count: number, post: BinaryComparePost): Promise<void> {
	try {
		const rows = await session.getRows(start, count);
		post({ command: 'hexRows', index: index, start: start, rows: rows, layoutVersion: session.layoutVersion, error: null });
	} catch (err) {
		post({ command: 'hexRows', index: index, start: start, rows: [], layoutVersion: session.layoutVersion, error: errorMessage(err) });
	}
}

/** Answer a page's `getImageData`: both sides as data URLs, bounded by the size limit. */
export async function respondImageData(session: HexDiffSession, index: number, file: GitFileChange, post: BinaryComparePost): Promise<void> {
	const reply = (error: string | null, oldData: string | null, newData: string | null) => {
		post({ command: 'imageData', index: index, error: error, oldData: oldData, newData: newData, oldSize: session.oldSize, newSize: session.newSize });
	};
	try {
		await session.init();
		const mime = imageMimeOf(file.newFilePath !== '' ? file.newFilePath : file.oldFilePath);
		const largest = Math.max(session.oldSize, session.newSize);
		if (mime === null || largest > IMAGE_SIZE_LIMIT) {
			reply(mime === null
				? t('compareImageUnsupportedType')
				: t('compareImageTooLarge', largest.toLocaleString(), IMAGE_SIZE_LIMIT.toLocaleString()), null, null);
			return;
		}
		const [oldBytes, newBytes] = await Promise.all([session.readSide('old'), session.readSide('new')]);
		reply(null,
			oldBytes !== null ? 'data:' + mime + ';base64,' + oldBytes.toString('base64') : null,
			newBytes !== null ? 'data:' + mime + ';base64,' + newBytes.toString('base64') : null);
	} catch (err) {
		reply(t('compareHexLoadError', errorMessage(err)), null, null);
	}
}

/**
 * Answer a page's `copyToClipboard`: the hex view's own selection copy, and its Copy Address -
 * both read entirely from data the page already has (the cached rows), so this only ever writes
 * the clipboard and echoes back whether that succeeded.
 */
export async function respondCopyToClipboard(post: BinaryComparePost, type: string, data: string): Promise<void> {
	post({ command: 'copyToClipboard', type: type, error: await copyToClipboard(data) });
}

/** Is a file change one the picture mode can render? (Shared so both pages agree with the responders.) */
export function isImageChange(file: GitFileChange): boolean {
	const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
	return imageMimeOf(filePath) !== null;
}
