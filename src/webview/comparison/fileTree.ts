/**
 * The file tree sidebar of the Commit Comparison View: the changed files built into a nested tree
 * of folders and files, with deferred +N/-M line counts patched in once they arrive.
 */

import { html, insertHtml, SafeHtml, setHtml } from '../common/html';
import { ComparisonFileModel, statusColour, statusLetter, changePath } from './model';

const TREE_INDENT = 6, TREE_FOLDER_BASE = 6, TREE_ARROW_WIDTH = 14, TREE_FILE_BASE = TREE_FOLDER_BASE + TREE_ARROW_WIDTH;

interface TreeFile {
	name: string;
	file: ComparisonFileModel;
	index: number;
}

interface TreeFolder {
	name: string;
	folders: { [name: string]: TreeFolder };
	files: TreeFile[];
}

/** A guide line is drawn for each ancestor level at the x-position of that ancestor folder's arrow
 *  (its centre), so sibling rows line up into one continuous vertical line per level. */
function treeGuidesBackground(depth: number): string {
	const layers: string[] = [];
	for (let level = 0; level < depth; level++) {
		const x = TREE_FOLDER_BASE + level * TREE_INDENT + TREE_ARROW_WIDTH / 2;
		layers.push('linear-gradient(var(--indent-guide-color), var(--indent-guide-color)) ' + x + 'px 0/1px 100% no-repeat');
	}
	return layers.join(', ');
}

export class FileTreeSidebar {
	/** The files whose counts have been computed: before that a null count means "on its way",
	 *  after it a null count means "binary". */
	private readonly settledCounts = new Set<number>();
	private readonly indexByPath = new Map<string, number>();
	private changes: ReadonlyArray<ComparisonFileModel> = [];

	public constructor(private readonly sidebar: HTMLElement) {}

	/** The file index a path belongs to (the counts response is keyed by path). */
	public indexOfPath(path: string): number | undefined {
		return this.indexByPath.get(path);
	}

	public fileAt(index: number): ComparisonFileModel | undefined {
		return this.changes[index];
	}

	public hasSettledCounts(index: number): boolean {
		return this.settledCounts.has(index);
	}

	/** The +N/-M counts of one file, or the pending placeholder while they are being computed. */
	public countsHtml(file: ComparisonFileModel, index: number): SafeHtml {
		if (file.additions !== null && file.deletions !== null) {
			return html`<span class="counts"><span class="additions">+${file.additions}</span> <span class="deletions">-${file.deletions}</span></span>`;
		}
		return !this.settledCounts.has(index) && (file.type === 'M' || file.type === 'R') ? html`<span class="counts pending">&hellip;</span>` : html``;
	}

	/** Build and render the tree of the comparison's file changes. */
	public render(changes: ReadonlyArray<ComparisonFileModel>, onSelect: (index: number) => void) {
		this.changes = changes;
		this.settledCounts.clear();
		this.indexByPath.clear();
		const root: TreeFolder = { name: '', folders: {}, files: [] };
		changes.forEach((file, index) => {
			const filePath = changePath(file);
			this.indexByPath.set(filePath, index);
			const path = filePath.split('/');
			let cur = root;
			for (let i = 0; i < path.length - 1; i++) {
				if (typeof cur.folders[path[i]] === 'undefined') cur.folders[path[i]] = { name: path[i], folders: {}, files: [] };
				cur = cur.folders[path[i]];
			}
			cur.files.push({ name: path[path.length - 1], file: file, index: index });
		});
		// The skeleton's persistent head (the statistics heading, and the phone sheet's title bar
		// with its close button) survives the re-render.
		const persistentHead = this.sidebar.querySelector('#sidebarHead');
		for (const child of Array.from(this.sidebar.children)) {
			if (child !== persistentHead) child.remove();
		}
		if (changes.length > 0) this.renderFolder(root, this.sidebar, 0, onSelect);
	}

	private renderFolder(folder: TreeFolder, container: HTMLElement, depth: number, onSelect: (index: number) => void) {
		for (const name of Object.keys(folder.folders).sort()) {
			const sub = folder.folders[name];
			const row = document.createElement('div');
			row.className = 'treeRow';
			row.style.paddingLeft = (TREE_FOLDER_BASE + depth * TREE_INDENT) + 'px';
			row.style.backgroundImage = treeGuidesBackground(depth);
			setHtml(row, html`<span class="arrow">&#9662;</span><span class="name">${name}</span>`);
			const children = document.createElement('div');
			row.addEventListener('click', () => {
				children.style.display = children.style.display === 'none' ? '' : 'none';
				const arrow = row.querySelector('.arrow');
				if (arrow !== null) arrow.textContent = children.style.display === 'none' ? '\u25B8' : '\u25BE';
			});
			container.appendChild(row);
			this.renderFolder(sub, children, depth + 1, onSelect);
			container.appendChild(children);
		}
		const sorted = folder.files.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of sorted) {
			const row = document.createElement('div');
			row.className = 'treeRow file';
			row.style.paddingLeft = (TREE_FILE_BASE + depth * TREE_INDENT) + 'px';
			row.style.backgroundImage = treeGuidesBackground(depth);
			row.dataset.index = String(entry.index);
			setHtml(row, html`<span class="letter" style="color: ${statusColour(entry.file)}">${statusLetter(entry.file)}</span>
				<span class="name" title="${changePath(entry.file)}">${entry.name}</span>${this.countsHtml(entry.file, entry.index)}`);
			row.addEventListener('click', () => onSelect(entry.index));
			container.appendChild(row);
		}
	}

	/** Mark one file's row as the selected one. */
	public select(index: number) {
		const rows = document.querySelectorAll('.treeRow.file');
		for (let i = 0; i < rows.length; i++) {
			const row = <HTMLElement>rows[i];
			row.classList.toggle('selected', parseInt(row.dataset.index!, 10) === index);
		}
	}

	/** Patch the deferred counts of the files they belong to, in the tree rows and the file
	 *  header. Returns TRUE when any total changed (the statistics header follows). */
	public applyCounts(counts: { [path: string]: { additions: number | null, deletions: number | null } }, selectedFile: number | undefined, renderCountsOf: (file: ComparisonFileModel, index: number) => SafeHtml): boolean {
		let totalsChanged = false;
		for (const path in counts) {
			const index = this.indexByPath.get(path);
			if (index === undefined) continue;
			const file = this.changes[index];
			if (file === undefined) continue;
			file.additions = counts[path].additions;
			file.deletions = counts[path].deletions;
			this.settledCounts.add(index);
			totalsChanged = true;
			const row = document.querySelector('.treeRow.file[data-index="' + index + '"]');
			if (row !== null) {
				const existing = row.querySelector('.counts');
				if (existing !== null) existing.remove();
				const markup = renderCountsOf(file, index);
				if (markup.html !== '') insertHtml(row, 'beforeend', markup);
			}
			if (index === selectedFile) {
				const header = document.querySelector('#fileHeader .counts');
				if (header !== null) header.remove();
				const filePath = document.getElementById('filePath');
				if (filePath !== null) {
					const headerHtml = renderCountsOf(file, index);
					if (headerHtml.html !== '') insertHtml(filePath, 'afterend', headerHtml);
				}
			}
		}
		return totalsChanged;
	}
}
