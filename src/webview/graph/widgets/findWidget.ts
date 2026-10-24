/**
 * The Find Widget: searches the loaded commits (message, author, hash, refs, date), highlights the
 * matches in the rendered rows and steps through them.
 */

import { formatShortDate } from '../../common/dates';
import { alterClass, CLASS_ACTIVE, CLASS_DISABLED, CLASS_TRANSITION, getChildNodesWithTextContent, getChildrenWithClassName, handledEvent } from '../../common/dom';
import { html, setHtml } from '../../common/html';
import { strings, formatStr } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { abbrevCommit, modifyColourOpacity, UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { getBranchLabels } from '../layout/refLabels';
import { FindWidgetState } from '../state/types';

const CLASS_FIND_CURRENT_COMMIT = 'findCurrentCommit';
const CLASS_FIND_MATCH = 'findMatch';
const ATTR_ERROR = 'data-error';

export class FindWidget {
	private text: string = '';
	private matches: { hash: string, elem: HTMLElement }[] = [];
	private position: number = -1;
	private visible: boolean = false;

	private readonly widgetElem: HTMLElement;
	private readonly inputElem: HTMLInputElement;
	private readonly caseSensitiveElem: HTMLElement;
	private readonly regexElem: HTMLElement;
	private readonly positionElem: HTMLElement;
	private readonly prevElem: HTMLElement;
	private readonly nextElem: HTMLElement;

	constructor(private readonly ctx: () => GraphContext) {
		this.widgetElem = document.createElement('div');
		this.widgetElem.className = 'findWidget';
		setHtml(this.widgetElem, html`<input id="findInput" type="text" placeholder="${strings.findPlaceholder}" disabled/><button type="button" id="findCaseSensitive" class="findModifier" title="${strings.findMatchCase}" aria-label="${strings.findMatchCase}">Aa</button><button type="button" id="findRegex" class="findModifier" title="${strings.findUseRegex}" aria-label="${strings.findUseRegex}">.*</button><span id="findPosition"></span><button type="button" id="findPrev" title="${strings.findPrevMatch}" aria-label="${strings.findPrevMatch}"></button><button type="button" id="findNext" title="${strings.findNextMatch}" aria-label="${strings.findNextMatch}"></button><button type="button" id="findOpenCdv" title="${strings.findOpenCdv}" aria-label="${strings.findOpenCdv}"></button><button type="button" id="findClose" title="${strings.findClose}" aria-label="${strings.findClose}"></button>`);
		document.body.appendChild(this.widgetElem);

		const workspaceState = ctx().store.workspaceViewState;
		this.inputElem = <HTMLInputElement>document.getElementById('findInput')!;
		let keyupTimeout: number | null = null;
		this.inputElem.addEventListener('keyup', (e) => {
			// The Enter of an IME composition commit also reports keyCode 13 — jumping to the
			// next match of the PREVIOUS query on the very keystroke that confirms the new one
			// is wrong; skip it and let the text-change path below handle the new query.
			if (e.isComposing || e.keyCode === 229) return;
			if ((e.keyCode ? e.keyCode === 13 : e.key === 'Enter') && this.text !== '') {
				if (e.shiftKey) {
					this.prev();
				} else {
					this.next();
				}
				handledEvent(e);
			} else {
				if (keyupTimeout !== null) window.clearTimeout(keyupTimeout);
				keyupTimeout = window.setTimeout(() => {
					keyupTimeout = null;
					if (this.text !== this.inputElem.value) {
						this.text = this.inputElem.value;
						// Matching only sees rows that are in the DOM, so leave windowed rendering
						// before scanning (a no-op unless the view is currently windowed)
						this.ctx().viewport.exitWindowedRender();
						this.clearMatches();
						this.findMatches(this.getCurrentHash(), true);
						this.openCommitDetailsViewForCurrentMatchIfEnabled();
						if (this.text === '') {
							// The query is gone: windowed rendering may resume (a no-op unless a
							// query had forced the full render)
							this.ctx().viewport.updateVirtualWindow();
						}
					}
				}, 200);
			}
		});

		this.caseSensitiveElem = document.getElementById('findCaseSensitive')!;
		alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
		this.caseSensitiveElem.addEventListener('click', () => {
			this.ctx().persistence.updateWorkspaceViewState('findIsCaseSensitive', !workspaceState.findIsCaseSensitive);
			alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
			this.clearMatches();
			this.findMatches(this.getCurrentHash(), true);
			this.openCommitDetailsViewForCurrentMatchIfEnabled();
		});

		this.regexElem = document.getElementById('findRegex')!;
		alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
		this.regexElem.addEventListener('click', () => {
			this.ctx().persistence.updateWorkspaceViewState('findIsRegex', !workspaceState.findIsRegex);
			alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
			this.clearMatches();
			this.findMatches(this.getCurrentHash(), true);
			this.openCommitDetailsViewForCurrentMatchIfEnabled();
		});

		this.positionElem = document.getElementById('findPosition')!;

		this.prevElem = document.getElementById('findPrev')!;
		this.prevElem.classList.add(CLASS_DISABLED);
		setHtml(this.prevElem, SVG_ICONS.arrowUp);
		this.prevElem.addEventListener('click', () => this.prev());

		this.nextElem = document.getElementById('findNext')!;
		this.nextElem.classList.add(CLASS_DISABLED);
		setHtml(this.nextElem, SVG_ICONS.arrowDown);
		this.nextElem.addEventListener('click', () => this.next());

		const openCdvElem = document.getElementById('findOpenCdv')!;
		setHtml(openCdvElem, SVG_ICONS.cdv);
		alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
		openCdvElem.addEventListener('click', () => {
			this.ctx().persistence.updateWorkspaceViewState('findOpenCommitDetailsView', !workspaceState.findOpenCommitDetailsView);
			alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
			this.openCommitDetailsViewForCurrentMatchIfEnabled();
		});

		const findCloseElem = document.getElementById('findClose')!;
		setHtml(findCloseElem, SVG_ICONS.close);
		findCloseElem.addEventListener('click', () => this.close());
	}

	/**
	 * Show the Find Widget.
	 * @param transition Should the Find Widget animate when becoming visible (sliding down).
	 */
	public show(transition: boolean) {
		if (!this.visible) {
			this.visible = true;
			this.inputElem.value = this.text;
			this.inputElem.disabled = false;
			this.updatePosition(-1, false);
			alterClass(this.widgetElem, CLASS_TRANSITION, transition);
			this.widgetElem.classList.add(CLASS_ACTIVE);
		}
		this.inputElem.focus();
		this.inputElem.select();
	}

	/** Close the Find Widget, sliding it up out of view. */
	public close() {
		if (!this.visible) return;
		this.visible = false;
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		const wasSearching = this.isSearching();
		this.clearMatches();
		this.text = '';
		this.matches = [];
		this.position = -1;
		this.inputElem.value = this.text;
		this.inputElem.disabled = true;
		this.widgetElem.removeAttribute(ATTR_ERROR);
		this.prevElem.classList.add(CLASS_DISABLED);
		this.nextElem.classList.add(CLASS_DISABLED);
		if (wasSearching) {
			// The query forced a full render: re-render, so windowed rendering can resume (a
			// no-op when it was never windowed in the first place)
			this.ctx().viewport.updateVirtualWindow();
		}
		this.ctx().persistence.saveState();
	}

	/**
	 * Is a find query currently active (matching requires every commit row to be rendered, so the
	 * view falls back to a full render instead of windowed rendering while this is TRUE).
	 */
	public isSearching() {
		return this.text !== '';
	}

	/** Refresh the Find Widget's state / matches after the commits have changed. */
	public refresh() {
		if (this.visible) {
			// Clear the existing highlights first: re-rendered tables reuse unchanged row elements
			// (including the .findMatch spans inside them), so scanning without clearing would nest
			// a new span inside each old one, which clearMatches (leaf-only) could never undo.
			const hash = this.getCurrentHash();
			this.clearMatches();
			this.findMatches(hash, false);
		}
	}

	/**
	 * Set the colours used to indicate the find matches.
	 * @param colour The base colour for the find matches.
	 */
	public setColour(colour: string) {
		document.body.style.setProperty('--git-graph-findMatch', colour);
		document.body.style.setProperty('--git-graph-findMatchCommit', modifyColourOpacity(colour, 0.5));
	}


	/* State */

	/** The current state of the Find Widget. */
	public getState(): FindWidgetState {
		return {
			text: this.text,
			currentHash: this.getCurrentHash(),
			visible: this.visible
		};
	}

	/** The commit hash of the current find match, or NULL if no commit is currently matched. */
	public getCurrentHash() {
		return this.position > -1 ? this.matches[this.position].hash : null;
	}

	/** Restore the Find Widget to an existing state. */
	public restoreState(state: FindWidgetState) {
		if (!state.visible) return;
		this.text = state.text;
		this.show(false);
		// During a webview reload this runs before the repository is loaded (currentRepo is still
		// unset), so skip matching here — the table's render calls refresh() once the commits have
		// been rendered.
		if (this.text !== '' && this.ctx().store.hasCurrentRepo()) this.findMatches(state.currentHash, false);
	}

	public isVisible() {
		return this.visible;
	}


	/* Matching */

	/**
	 * Find all matches based on the user's criteria.
	 * @param goToCommitHash If this commit hash matches the criteria, directly go to this commit instead of starting at the first match.
	 * @param scrollToCommit Should the resultant find match be scrolled to (so it's visible in the view).
	 */
	private findMatches(goToCommitHash: string | null, scrollToCommit: boolean) {
		const ctx = this.ctx(), store = ctx.store, workspaceState = store.workspaceViewState;
		this.matches = [];
		this.position = -1;

		if (this.text !== '') {
			// The mobile layout drops the Author and Commit columns, but its two-line rows still show
			// the author and the abbreviated hash under the subject: both stay searchable there
			const colVisibility = ctx.layout.isMobileLayout() ? { date: false, author: true, commit: true } : ctx.layout.getColumnVisibility();
			let findPattern: RegExp | null, findGlobalPattern: RegExp | null;
			const regexText = workspaceState.findIsRegex ? this.text : this.text.replace(/[\\\[\](){}|.*+?^$]/g, '\\$&'), flags = 'u' + (workspaceState.findIsCaseSensitive ? '' : 'i');
			try {
				findPattern = new RegExp(regexText, flags);
				findGlobalPattern = new RegExp(regexText, 'g' + flags);
				this.widgetElem.removeAttribute(ATTR_ERROR);
			} catch (e) {
				findPattern = null;
				findGlobalPattern = null;
				this.widgetElem.setAttribute(ATTR_ERROR, (<Error>e).message);
			}
			if (findPattern !== null && findGlobalPattern !== null) {
				// A static snapshot: the live collection of rows would be re-derived on each access,
				// turning the scan below into an O(n^2) pass over the full commit list.
				const commitElems = Array.from(document.getElementsByClassName('commit')) as HTMLElement[];
				let j = 0, zeroLengthMatch = false;

				// Search the commit data itself to detect commits that match, so that dom tree traversal is performed on matching commit rows (for performance)
				const commits = store.commits;
				for (let i = 0; i < commits.length; i++) {
					const commit = commits[i];
					const branchLabels = getBranchLabels(commit.heads, commit.remotes, store.config.referenceLabels.combineLocalAndRemoteBranchLabels);
					if (commit.hash !== UNCOMMITTED && (
						(colVisibility.author && findPattern.test(commit.author))
						|| (colVisibility.commit && (commit.hash.search(findPattern) === 0 || findPattern.test(abbrevCommit(commit.hash))))
						|| findPattern.test(commit.message)
						|| branchLabels.heads.some((head) => findPattern!.test(head.name) || head.remotes.some((remote) => findPattern!.test(remote)))
						|| branchLabels.remotes.some((remote) => findPattern!.test(remote.name))
						|| commit.tags.some((tag) => findPattern!.test(tag.name))
						|| (colVisibility.date && findPattern.test(formatShortDate(commit.date, store.config.dateFormat).formatted))
						|| (commit.stash !== null && findPattern.test(commit.stash.selector))
					)) {
						const idStr = i.toString();
						while (j < commitElems.length && commitElems[j].dataset.id !== idStr) j++;
						if (j === commitElems.length) continue;

						this.matches.push({ hash: commit.hash, elem: commitElems[j] });

						// Highlight matches
						const textElems = getChildNodesWithTextContent(commitElems[j]);
						for (let k = 0; k < textElems.length; k++) {
							const textElem = textElems[k];
							let matchStart = 0, matchEnd = 0, match: RegExpExecArray | null;
							const text = textElem.textContent!;
							findGlobalPattern.lastIndex = 0;
							while ((match = findGlobalPattern.exec(text)) !== null) {
								if (match[0].length === 0) {
									zeroLengthMatch = true;
									break;
								}
								if (matchEnd !== match.index) {
									// This match isn't immediately after the previous match, or isn't at the beginning of the text
									if (matchStart !== matchEnd) {
										// There was a previous match, insert it in a text node
										textElem.parentNode!.insertBefore(FindWidget.createMatchElem(text.substring(matchStart, matchEnd)), textElem);
									}
									// Insert a text node containing the text between the last match and the current match
									textElem.parentNode!.insertBefore(document.createTextNode(text.substring(matchEnd, match.index)), textElem);
									matchStart = match.index;
								}
								matchEnd = findGlobalPattern.lastIndex;
							}
							if (matchEnd > 0) {
								// There were one or more matches
								if (matchStart !== matchEnd) {
									// There was a match, insert it in a text node
									textElem.parentNode!.insertBefore(FindWidget.createMatchElem(text.substring(matchStart, matchEnd)), textElem);
								}
								if (matchEnd !== text.length) {
									// There was some text after last match, update the textElem (the last node of it's parent) to contain the remaining text.
									textElem.textContent = text.substring(matchEnd);
								} else {
									// The last match was at the end of the text, the textElem is no longer required, so delete it
									textElem.parentNode!.removeChild(textElem);
								}
							}
							if (zeroLengthMatch) break;
						}
						if (colVisibility.commit && commit.hash.search(findPattern) === 0 && !findPattern.test(abbrevCommit(commit.hash)) && textElems.length > 0) {
							// The commit matches on more than the abbreviated commit, so the commit should be highlighted
							const commitNode = textElems[textElems.length - 1]; // Commit is always the last column if it is visible
							commitNode.parentNode!.replaceChild(FindWidget.createMatchElem(commitNode.textContent!), commitNode);
						}
						if (zeroLengthMatch) break;
					}
				}
				if (zeroLengthMatch) {
					this.widgetElem.setAttribute(ATTR_ERROR, strings.findZeroLengthMatch);
					this.clearMatches();
					this.matches = [];
				}
			}
		} else {
			this.widgetElem.removeAttribute(ATTR_ERROR);
		}

		alterClass(this.prevElem, CLASS_DISABLED, this.matches.length === 0);
		alterClass(this.nextElem, CLASS_DISABLED, this.matches.length === 0);

		let newPos = -1;
		if (this.matches.length > 0) {
			newPos = 0;
			if (goToCommitHash !== null) {
				const pos = this.matches.findIndex((match) => match.hash === goToCommitHash);
				if (pos > -1) newPos = pos;
			}
		}
		this.updatePosition(newPos, scrollToCommit);
	}

	/** Clear all of the highlighted find matches in the view. */
	private clearMatches() {
		for (let i = 0; i < this.matches.length; i++) {
			if (i === this.position) this.matches[i].elem.classList.remove(CLASS_FIND_CURRENT_COMMIT);
			const matchElems = getChildrenWithClassName(this.matches[i].elem, CLASS_FIND_MATCH);
			for (let j = 0; j < matchElems.length; j++) {
				const matchElem = matchElems[j];
				let text = matchElem.childNodes[0].textContent!;

				// Combine current text with the text from previous sibling text nodes
				let node = matchElem.previousSibling, elem = matchElem.previousElementSibling;
				while (node !== null && node !== elem && node.textContent !== null) {
					text = node.textContent + text;
					matchElem.parentNode!.removeChild(node);
					node = matchElem.previousSibling;
				}

				// Combine current text with the text from next sibling text nodes
				node = matchElem.nextSibling;
				elem = matchElem.nextElementSibling;
				while (node !== null && node !== elem && node.textContent !== null) {
					text = text + node.textContent;
					matchElem.parentNode!.removeChild(node);
					node = matchElem.nextSibling;
				}

				matchElem.parentNode!.replaceChild(document.createTextNode(text), matchElem);
			}
		}
	}

	/**
	 * Update the user's position in the set of find matches.
	 * @param position The new position index within the find matches.
	 * @param scrollToCommit After updating the user's position in the set of find matches, should the current match be scrolled to (so it's visible in the view).
	 */
	private updatePosition(position: number, scrollToCommit: boolean) {
		const ctx = this.ctx();
		if (this.position > -1) this.matches[this.position].elem.classList.remove(CLASS_FIND_CURRENT_COMMIT);
		this.position = position;
		if (this.position > -1) {
			this.matches[this.position].elem.classList.add(CLASS_FIND_CURRENT_COMMIT);
			if (scrollToCommit) ctx.viewport.scrollToCommit(this.matches[position].hash, false);
		}
		setHtml(this.positionElem, this.matches.length > 0 ? html`${formatStr(strings.findPositionOf, String(this.position + 1), String(this.matches.length))}` : html`${strings.findNoResults}`);
		ctx.persistence.saveState();
	}

	/** Move the user's position to the previous match in the set of find matches. */
	private prev() {
		if (this.matches.length === 0) return;
		this.updatePosition(this.position > 0 ? this.position - 1 : this.matches.length - 1, true);
		this.openCommitDetailsViewForCurrentMatchIfEnabled();
	}

	/** Move the user's position to the next match in the set of find matches. */
	private next() {
		if (this.matches.length === 0) return;
		this.updatePosition(this.position < this.matches.length - 1 ? this.position + 1 : 0, true);
		this.openCommitDetailsViewForCurrentMatchIfEnabled();
	}

	/** If the Find Widget is configured to open the Commit Details View for the current find match, load the Commit Details View accordingly. */
	private openCommitDetailsViewForCurrentMatchIfEnabled() {
		const ctx = this.ctx();
		if (ctx.store.workspaceViewState.findOpenCommitDetailsView) {
			const commitHash = this.getCurrentHash();
			if (commitHash !== null && !ctx.details.isOpen(commitHash, null)) {
				const commitElem = ctx.table.findCommitElem(ctx.store.getCommitId(commitHash));
				if (commitElem !== null) {
					ctx.details.load(commitElem);
				}
			}
		}
	}

	/** Create a find match element containing the specified text. */
	private static createMatchElem(text: string) {
		const span = document.createElement('span');
		span.className = CLASS_FIND_MATCH;
		span.textContent = text;
		return span;
	}
}
