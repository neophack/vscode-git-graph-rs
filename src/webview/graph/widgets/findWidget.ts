/**
 * The Find Widget: searches the loaded commits (message, author, hash, refs, date), highlights the
 * matches in the rendered rows and steps through them.
 */

import { formatShortDate } from '../../common/dates';
import { alterClass, CLASS_ACTIVE, CLASS_DISABLED, CLASS_TRANSITION, getChildNodesWithTextContent, getChildrenWithClassName, handledEvent } from '../../common/dom';
import { html, setHtml } from '../../common/html';
import { strings, formatStr } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { injectOnDemandStyles } from '../../common/onDemandStyles';
import { abbrevCommit, modifyColourOpacity, UNCOMMITTED } from '../../common/util';
import { Component } from '../component';
import { GraphContext } from '../context';
import { getBranchLabels } from '../layout/refLabels';
import { cancelScheduledFrame, scheduleFrame } from '../render/scheduler';
import { FindWidgetState } from '../state/types';
import { FindWidgetSurface } from './surfaces';
import findWidgetCss from '../../styles/findWidget.css';
import tabletFindWidgetCss from '../../styles/tablet/findWidget.css';

// This module sits in an on-demand chunk (task 5.9): its stylesheet rides the chunk as text
// (the sheet carries its own phone-layout section; the tablet sheet follows it)
injectOnDemandStyles(findWidgetCss);
injectOnDemandStyles(tabletFindWidgetCss);

const CLASS_FIND_CURRENT_COMMIT = 'findCurrentCommit';
const CLASS_FIND_MATCH = 'findMatch';
const ATTR_ERROR = 'data-error';
/** How many commits one search slice tests before yielding to the frame (task 5.10). */
const FIND_SEARCH_SLICE = 500;

/**
 * The Find Widget: searches the loaded commits (message, author, hash, refs, date), highlights the
 * matches in the rendered rows and steps through them.
 *
 * Every listener the widget creates lives in its component store (F3) — the widget is a page
 * singleton, but its controls' handlers still answer to dispose(), and every DOM lookup runs
 * under its own element (or the commit table it highlights).
 */
export class FindWidget extends Component implements FindWidgetSurface {
	private text: string = '';
	private matches: { hash: string, elem: HTMLElement }[] = [];
	private position: number = -1;
	private visible: boolean = false;
	/**
	 * The generation of the current search (task 5.10): every new query, refresh or close bumps
	 * it, and the slices of an in-flight scan compare against it and abort - a stale search never
	 * lands its (partial) results over a newer one.
	 */
	private searchToken: number = 0;
	private searchFrameId: number | null = null;
	/** Is an incremental scan currently running (matches are still incomplete). */
	private searchScanning: boolean = false;
	/** Did the last scan run to completion (only then may the next one refine from its results). */
	private searchComplete: boolean = true;
	/** The completed previous query and the indices of its matching commits (refinement seeds). */
	private previousQuery: string = '';
	private previousCandidates: number[] | null = null;

	private readonly widgetElem: HTMLElement;
	private readonly inputElem: HTMLInputElement;
	private readonly caseSensitiveElem: HTMLElement;
	private readonly regexElem: HTMLElement;
	private readonly positionElem: HTMLElement;
	private readonly prevElem: HTMLElement;
	private readonly nextElem: HTMLElement;

	protected override onDispose(): void {
		// A disposed widget must not leave an in-flight scan (its next slice would run after
		// the listeners are gone) or a pending keyup debounce behind (F3)
		this.cancelSearch();
	}

	constructor(private readonly ctx: () => GraphContext) {
		super(document.createElement('div'));
		this.widgetElem = <HTMLElement>this.root;
		this.widgetElem.className = 'findWidget';
		setHtml(this.widgetElem, html`<input id="findInput" type="text" placeholder="${strings.findPlaceholder}" disabled/><button type="button" id="findCaseSensitive" class="findModifier" title="${strings.findMatchCase}" aria-label="${strings.findMatchCase}">Aa</button><button type="button" id="findRegex" class="findModifier" title="${strings.findUseRegex}" aria-label="${strings.findUseRegex}">.*</button><span id="findPosition"></span><button type="button" id="findPrev" title="${strings.findPrevMatch}" aria-label="${strings.findPrevMatch}"></button><button type="button" id="findNext" title="${strings.findNextMatch}" aria-label="${strings.findNextMatch}"></button><button type="button" id="findOpenCdv" title="${strings.findOpenCdv}" aria-label="${strings.findOpenCdv}"></button><button type="button" id="findClose" title="${strings.findClose}" aria-label="${strings.findClose}"></button>`);
		document.body.appendChild(this.widgetElem);

		const workspaceState = ctx().store.workspaceViewState;
		this.inputElem = <HTMLInputElement>this.byId('findInput')!;
		let keyupTimeout: number | null = null;
		this.listen(this.inputElem, 'keyup', (e) => {
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
				// The debounce: a burst of keystrokes (or an IME composition) runs ONE search, of
				// the final text; each new burst also cancels whatever the previous search was
				// still scanning (see findMatches)
				keyupTimeout = window.setTimeout(() => {
					keyupTimeout = null;
					if (this.text !== this.inputElem.value) {
						this.text = this.inputElem.value;
						// Matching only sees rows that are in the DOM, so leave windowed rendering
						// before scanning (a no-op unless the view is currently windowed)
						this.ctx().viewport.exitWindowedRender();
						this.clearMatches();
						this.findMatches(this.getCurrentHash(), true, true);
						if (this.text === '') {
							// The query is gone: windowed rendering may resume (a no-op unless a
							// query had forced the full render)
							this.ctx().viewport.updateVirtualWindow();
						}
					}
				}, 200);
			}
		});

		this.caseSensitiveElem = this.byId('findCaseSensitive')!;
		alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
		this.listen(this.caseSensitiveElem, 'click', () => {
			this.ctx().persistence.updateWorkspaceViewState('findIsCaseSensitive', !workspaceState.findIsCaseSensitive);
			alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
			this.clearMatches();
			this.findMatches(this.getCurrentHash(), true, true);
		});

		this.regexElem = this.byId('findRegex')!;
		alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
		this.listen(this.regexElem, 'click', () => {
			this.ctx().persistence.updateWorkspaceViewState('findIsRegex', !workspaceState.findIsRegex);
			alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
			this.clearMatches();
			this.findMatches(this.getCurrentHash(), true, true);
		});

		this.positionElem = this.byId('findPosition')!;

		this.prevElem = this.byId('findPrev')!;
		this.prevElem.classList.add(CLASS_DISABLED);
		setHtml(this.prevElem, SVG_ICONS.arrowUp);
		this.listen(this.prevElem, 'click', () => this.prev());

		this.nextElem = this.byId('findNext')!;
		this.nextElem.classList.add(CLASS_DISABLED);
		setHtml(this.nextElem, SVG_ICONS.arrowDown);
		this.listen(this.nextElem, 'click', () => this.next());

		const openCdvElem = this.byId('findOpenCdv')!;
		setHtml(openCdvElem, SVG_ICONS.cdv);
		alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
		this.listen(openCdvElem, 'click', () => {
			this.ctx().persistence.updateWorkspaceViewState('findOpenCommitDetailsView', !workspaceState.findOpenCommitDetailsView);
			alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
			this.openCommitDetailsViewForCurrentMatchIfEnabled();
		});

		const findCloseElem = this.byId('findClose')!;
		setHtml(findCloseElem, SVG_ICONS.close);
		this.listen(findCloseElem, 'click', () => this.close());
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
		this.cancelSearch();
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
			// The commits changed, so the previous search's refinement candidates are stale - the
			// restarted scan goes back to the whole loaded list.
			const hash = this.getCurrentHash();
			this.clearMatches();
			this.previousQuery = '';
			this.previousCandidates = null;
			this.findMatches(hash, false, false);
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
		if (this.text !== '' && this.ctx().store.hasCurrentRepo()) this.findMatches(state.currentHash, false, false);
	}

	public isVisible() {
		return this.visible;
	}

	/** Is an incremental search still scanning the loaded commits. */
	public isScanning() {
		return this.searchScanning;
	}


	/* Matching */

	/**
	 * Find all matches based on the user's criteria.
	 *
	 * Incremental and cancellable (task 5.10): the loaded commits are tested in slices of
	 * FIND_SEARCH_SLICE, the first synchronously (short lists and the first matches land
	 * immediately) and the rest on successive animation frames, so a large repository no longer
	 * blocks a frame while it is scanned. Each new search - a new query, a modifier toggle, a
	 * refresh, a close - bumps the token, and the slices of the previous scan see the mismatch and
	 * abort: a stale search never lands partial results over a newer one. A non-regex query that
	 * merely extends the previous COMPLETED query refines from its matches instead of rescanning
	 * every loaded commit (a longer substring cannot match where the shorter one did not).
	 * @param goToCommitHash If this commit hash matches the criteria, directly go to this commit instead of starting at the first match.
	 * @param scrollToCommit Should the resultant find match be scrolled to (so it's visible in the view).
	 * @param openDetails Should the Commit Details View open for the resulting match (the input paths; a plain refresh keeps it as it is).
	 */
	private findMatches(goToCommitHash: string | null, scrollToCommit: boolean, openDetails: boolean) {
		const ctx = this.ctx(), store = ctx.store, workspaceState = store.workspaceViewState;
		this.cancelSearch();
		const token = this.searchToken;
		this.matches = [];
		this.position = -1;

		let findPattern: RegExp | null = null, findGlobalPattern: RegExp | null = null;
		if (this.text !== '') {
			// The mobile layout drops the Author and Commit columns, but its two-line rows still show
			// the author and the abbreviated hash under the subject: both stay searchable there
			const regexText = workspaceState.findIsRegex ? this.text : this.text.replace(/[\\\[\](){}|.*+?^$]/g, '\\$&'), flags = 'u' + (workspaceState.findIsCaseSensitive ? '' : 'i');
			try {
				findPattern = new RegExp(regexText, flags);
				findGlobalPattern = new RegExp(regexText, 'g' + flags);
				this.widgetElem.removeAttribute(ATTR_ERROR);
			} catch (e) {
				this.widgetElem.setAttribute(ATTR_ERROR, (<Error>e).message);
			}
		} else {
			this.widgetElem.removeAttribute(ATTR_ERROR);
		}

		if (findPattern === null || findGlobalPattern === null) {
			// Nothing to scan (empty query, or a pattern that does not compile): finish at once
			this.searchComplete = true;
			this.previousQuery = '';
			this.previousCandidates = null;
			this.finishSearch(goToCommitHash, scrollToCommit, openDetails);
			return;
		}

		// The refinement seed: the indices the previous COMPLETED search matched, when this query
		// merely extends it as plain text
		const candidates = !workspaceState.findIsRegex && this.searchComplete && this.previousCandidates !== null && this.text.startsWith(this.previousQuery)
			? this.previousCandidates
			: null;
		const colVisibility = ctx.layout.isTwoLineRows() ? { date: false, author: true, commit: true } : ctx.layout.getColumnVisibility();
		// A static snapshot: the live collection of rows would be re-derived on each access,
		// turning the scan below into an O(n^2) pass over the full commit list. Scoped to the
		// commit table (F3): the rows are the table's, not the document's.
		const commitElems = Array.from(ctx.dom.table.getElementsByClassName('commit')) as HTMLElement[];
		const commits = store.commits;
		const total = candidates !== null ? candidates.length : commits.length;
		// The document-order cursor over the (ascending data-id) rows, shared by every slice
		let j = 0;

		this.searchScanning = true;
		this.searchComplete = false;

		const scanSlice = (from: number): void => {
			if (token !== this.searchToken) return; // cancelled: a newer search owns the widget now

			let zeroLengthMatch = false;
			let n = from;
			for (; n < total && n - from < FIND_SEARCH_SLICE; n++) {
				const i = candidates !== null ? candidates[n] : n;
				const commit = commits[i];
				if (commit === undefined) continue;
				// Search the commit data itself to detect commits that match, so that dom tree traversal is performed on matching commit rows (for performance)
				const branchLabels = getBranchLabels(commit.heads, commit.remotes, store.config.referenceLabels.combineLocalAndRemoteBranchLabels);
				if (commit.hash !== UNCOMMITTED && (
					(colVisibility.author && findPattern!.test(commit.author))
					|| (colVisibility.commit && (commit.hash.search(findPattern!) === 0 || findPattern!.test(abbrevCommit(commit.hash))))
					|| findPattern!.test(commit.message)
					|| branchLabels.heads.some((head) => findPattern!.test(head.name) || head.remotes.some((remote) => findPattern!.test(remote)))
					|| branchLabels.remotes.some((remote) => findPattern!.test(remote.name))
					|| commit.tags.some((tag) => findPattern!.test(tag.name))
					|| (colVisibility.date && findPattern!.test(formatShortDate(commit.date, store.config.dateFormat).formatted))
					|| (commit.stash !== null && findPattern!.test(commit.stash.selector))
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
						findGlobalPattern!.lastIndex = 0;
						while ((match = findGlobalPattern!.exec(text)) !== null) {
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
							matchEnd = findGlobalPattern!.lastIndex;
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
					if (colVisibility.commit && commit.hash.search(findPattern!) === 0 && !findPattern!.test(abbrevCommit(commit.hash)) && textElems.length > 0) {
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
				this.searchScanning = false;
				this.searchComplete = true;
				this.previousQuery = '';
				this.previousCandidates = null;
				this.finishSearch(goToCommitHash, scrollToCommit, false);
				return;
			}
			if (n < total) {
				// More to scan: yield to the frame, keeping the search cancellable
				this.searchFrameId = scheduleFrame(() => {
					this.searchFrameId = null;
					scanSlice(n);
				});
				return;
			}
			this.searchScanning = false;
			this.searchComplete = true;
			this.previousQuery = this.text;
			this.previousCandidates = this.matches.map((match) => store.commitLookup[match.hash]);
			this.finishSearch(goToCommitHash, scrollToCommit, openDetails);
		};
		scanSlice(0);
	}

	/** Cancel the in-flight incremental search (a new search or a close takes over). */
	private cancelSearch() {
		this.searchToken++;
		if (this.searchFrameId !== null) {
			cancelScheduledFrame(this.searchFrameId);
			this.searchFrameId = null;
		}
		this.searchScanning = false;
	}

	/**
	 * The end of every search: settle the position (and the buttons), and open the Commit Details
	 * View for the landed match when its caller asked for it.
	 */
	private finishSearch(goToCommitHash: string | null, scrollToCommit: boolean, openDetails: boolean) {
		alterClass(this.prevElem, CLASS_DISABLED, this.searchScanning || this.matches.length === 0);
		alterClass(this.nextElem, CLASS_DISABLED, this.searchScanning || this.matches.length === 0);

		let newPos = -1;
		if (this.matches.length > 0) {
			newPos = 0;
			if (goToCommitHash !== null) {
				const pos = this.matches.findIndex((match) => match.hash === goToCommitHash);
				if (pos > -1) newPos = pos;
			}
		}
		this.updatePosition(newPos, scrollToCommit);
		if (openDetails) this.openCommitDetailsViewForCurrentMatchIfEnabled();
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
		// While the incremental scan is still running the match set is incomplete: the buttons are
		// disabled, and the keyboard path waits for the scan to land rather than stepping through
		// a partial set whose total is still unknown
		if (this.searchScanning || this.matches.length === 0) return;
		this.updatePosition(this.position > 0 ? this.position - 1 : this.matches.length - 1, true);
		this.openCommitDetailsViewForCurrentMatchIfEnabled();
	}

	/** Move the user's position to the next match in the set of find matches. */
	private next() {
		if (this.searchScanning || this.matches.length === 0) return;
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
