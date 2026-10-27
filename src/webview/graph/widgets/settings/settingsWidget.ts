import { alterClass, CLASS_ACTIVE, CLASS_LOADING, CLASS_TRANSITION } from '../../../common/dom';
import { html, setHtml } from '../../../common/html';
import { strings } from '../../../common/i18n/index';
import { SVG_ICONS } from '../../../common/icons';
import { injectOnDemandStyles } from '../../../common/onDemandStyles';
import * as GG from '../../../common/protocol';
import { Component } from '../../component';
import { GraphContext } from '../../context';
import { measureClientSize } from '../../render/measure';
import { SettingsWidgetState } from '../../state/types';
import { SettingsWidgetSurface } from '../surfaces';
import { maybeSeedCommitAuthors } from './commitAuthors';
import { renderGlobalColumn, wireGlobalSettings } from './globalSection';
import { renderRepoColumn, wireRepoSettings } from './repoSection';
import type { SettingsHost } from './settingsHost';
import settingsCss from '../../../styles/settingsWidget.css';

// This module sits in an on-demand chunk (task 5.9): its stylesheet rides the chunk as text (the
// sheet carries its own phone-layout and tablet-layout sections)
injectOnDemandStyles(settingsCss);

/**
 * The Settings Widget: an overlay with the Repository Settings (the persisted state of the
 * current repository, its remotes, commit author, issue linking and pull request integrations,
 * Gerrit) and the Global Settings (the Extension Settings that shape the graph, commit loading,
 * fetching and review integrations), plus the entries of the repository tools.
 *
 * The widget is a page singleton with two listener lifetimes (F3): the shell's own (the close
 * button, the widget's scroll) live in the component store for dispose(), and each RENDER's
 * wiring (the settings rows it just wrote) lives on the surface store, cleared at the top of
 * the next render and on close — a re-render or a repo switch cannot accumulate handlers or
 * pin the replaced rows' elements. Every DOM lookup runs under the widget's own element.
 *
 * This module is the SHELL: the overlay element, the two columns, the loading state, the scroll
 * persistence and the open/close wiring. The sections themselves - their markup and their
 * wiring - live in the sibling modules of this directory and reach back through the
 * {@link SettingsHost} surface the shell implements (settingsHost.ts).
 */
export class SettingsWidget extends Component implements SettingsWidgetSurface, SettingsHost {
	private _currentRepo: string | null = null;
	private _repo: Readonly<GG.GitRepoState> | null = null;
	private _config: Readonly<GG.GitRepoConfig> | null = null;
	private loading: boolean = false;
	/** The one-shot guard of the commit authors seeding (commitAuthors.ts): attempted at most once per widget. */
	private readonly commitAuthorsSeed = { attempted: false };
	private scrollTop: number = 0;
	private repoColumnScrollTop: number = 0;
	private globalColumnScrollTop: number = 0;

	private readonly widgetElem: HTMLElement;
	private readonly contentsElem: HTMLElement;
	private readonly loadingElem: HTMLElement;

	constructor(public readonly ctx: () => GraphContext) {
		super(document.createElement('div'));
		this.widgetElem = <HTMLElement>this.root;
		this.widgetElem.id = 'settingsWidget';
		setHtml(this.widgetElem, html`<h2>${strings.settingsTitle}</h2><div id="settingsContent"></div><div id="settingsLoading"></div><div id="settingsClose"></div>`);
		document.body.appendChild(this.widgetElem);

		this.observeElemScroll(this.widgetElem, this.scrollTop, (scrollTop) => {
			this.scrollTop = scrollTop;
		}, () => {
			if (this.currentRepo !== null) {
				this.ctx().persistence.saveState();
			}
		});

		this.contentsElem = this.byId('settingsContent')!;
		this.loadingElem = this.byId('settingsLoading')!;

		const settingsClose = this.byId('settingsClose')!;
		setHtml(settingsClose, SVG_ICONS.close);
		this.makeKeyboardActivatable(settingsClose);
		this.listen(settingsClose, 'click', () => this.close());
	}

	/**
	 * Show the Settings Widget.
	 * @param currentRepo The repository that is currently loaded in the view.
	 * @param isInitialLoad Is this the initial load of the Setting Widget, or is it being shown when restoring a previous state.
	 * @param scrollTop The scrollTop the Settings Widget should initially be set to.
	 * @param repoColumnScrollTop The scrollTop the Repository Settings column should initially be set to.
	 * @param globalColumnScrollTop The scrollTop the Global Settings column should initially be set to.
	 */
	public show(currentRepo: string, isInitialLoad: boolean = true, scrollTop: number = 0, repoColumnScrollTop: number = 0, globalColumnScrollTop: number = 0) {
		if (this.currentRepo !== null) return;
		const ctx = this.ctx();
		this._currentRepo = currentRepo;
		this.scrollTop = scrollTop;
		this.repoColumnScrollTop = repoColumnScrollTop;
		this.globalColumnScrollTop = globalColumnScrollTop;
		alterClass(this.widgetElem, CLASS_TRANSITION, isInitialLoad);
		this.widgetElem.classList.add(CLASS_ACTIVE);
		ctx.persistence.saveState();
		this.refresh();
		if (isInitialLoad) {
			ctx.loader.requestLoadConfig();
		}
	}

	/** Refresh the Settings Widget after an action affecting it's content has completed. */
	public refresh() {
		if (this.currentRepo === null) return;
		const store = this.ctx().store;
		this._repo = store.getRepoState(this.currentRepo);
		this._config = store.gitConfig;
		this.loading = store.isConfigLoading();
		maybeSeedCommitAuthors(this.ctx(), this.config, this.commitAuthorsSeed);
		this.render();
	}

	/** Close the Settings Widget, sliding it up out of view. */
	public close() {
		if (this.currentRepo === null) return;
		// The open render's wiring goes with its content (F3)
		this.clearSurfaceListeners();
		this._currentRepo = null;
		this._repo = null;
		this._config = null;
		this.loading = false;
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.widgetElem.classList.remove(CLASS_LOADING);
		setHtml(this.contentsElem, html``);
		setHtml(this.loadingElem, html``);
		this.ctx().persistence.saveState();
	}


	/* State */

	public getState(): SettingsWidgetState {
		return {
			currentRepo: this.currentRepo,
			scrollTop: this.scrollTop,
			repoColumnScrollTop: this.repoColumnScrollTop,
			globalColumnScrollTop: this.globalColumnScrollTop
		};
	}

	/** Restore the Settings Widget to an existing state. */
	public restoreState(state: SettingsWidgetState) {
		if (state.currentRepo === null) return;
		this.show(state.currentRepo, false, state.scrollTop, state.repoColumnScrollTop || 0, state.globalColumnScrollTop || 0);
	}

	/** Is the Settings Widget currently visible. */
	public isVisible() {
		return this.currentRepo !== null;
	}


	/* The SettingsHost surface for the section modules (settingsHost.ts) */

	/** The repository the Settings Widget is open on (NULL while it is closed). */
	public get currentRepo(): string | null {
		return this._currentRepo;
	}

	/** The persisted state of the current repository, as the widget last refreshed it (NULL while it is closed). */
	public get repo(): Readonly<GG.GitRepoState> | null {
		return this._repo;
	}

	/** The current repository's Git configuration - the commit authors and remotes (NULL until it loads). */
	public get config(): Readonly<GG.GitRepoConfig> | null {
		return this._config;
	}

	/** Re-render the widget's content (a section persisted a change the user must see). */
	public rerender(): void {
		this.render();
	}

	/** The shell's scoped DOM lookup, public for the section modules. */
	public override byId(id: string): HTMLElement | null {
		return super.byId(id);
	}

	/** The shell's surface listener store, public for the section modules. */
	public override listenOnSurface(target: EventTarget, event: string, listener: EventListener): void {
		super.listenOnSurface(target, event, listener);
	}

	/**
	 * Register a listener on every element under the rendered content carrying a class name, on
	 * the surface store (F3): the next render or close removes them all.
	 */
	public listenToClassOnSurface(className: string, event: string, listener: EventListener) {
		const elems = this.contentsElem.getElementsByClassName(className);
		for (let i = 0; i < elems.length; i++) this.listenOnSurface(elems[i], event, listener);
	}


	/* Rendering */

	private render() {
		// The previous render's wiring dies with the elements it was attached to (F3): the
		// surface store is cleared before the content is replaced, so neither the store nor the
		// closures in it can pin the replaced rows.
		this.clearSurfaceListeners();
		if (this.currentRepo !== null && this.repo !== null) {
			const ctx = this.ctx();
			const repoHtml = renderRepoColumn(ctx, this.currentRepo, this.repo, this.config);
			const globalHtml = renderGlobalColumn(ctx, this.config);

			setHtml(this.contentsElem, html`<div id="settingsColumns"><div class="settingsColumn" id="settingsRepoColumn"><h3 class="settingsColumnTitle" title="${strings.settingsColumnRepoHint}">${strings.settingsColumnRepo}</h3>${repoHtml}</div><div class="settingsColumn" id="settingsGlobalColumn"><h3 class="settingsColumnTitle" title="${strings.settingsColumnGlobalHint}">${strings.settingsColumnGlobal}</h3>${globalHtml}</div></div>`);

			this.observeSurfaceElemScroll(this.byId('settingsRepoColumn'), this.repoColumnScrollTop, (scrollTop) => {
				this.repoColumnScrollTop = scrollTop;
			}, () => ctx.persistence.saveState());
			this.observeSurfaceElemScroll(this.byId('settingsGlobalColumn'), this.globalColumnScrollTop, (scrollTop) => {
				this.globalColumnScrollTop = scrollTop;
			}, () => ctx.persistence.saveState());

			wireGlobalSettings(this);
			wireRepoSettings(this, this.repo);

			const btns = this.widgetElem.querySelectorAll('.settingsSectionButtons > div, .settingsSection > table td.btns > div, .hideRemoteBtn, .authorSwitchRow');
			for (let i = 0; i < btns.length; i++) this.makeSurfaceKeyboardActivatable(<HTMLElement>btns[i]);
		}

		alterClass(this.widgetElem, CLASS_LOADING, this.loading);
		setHtml(this.loadingElem, this.loading ? html`<span>${SVG_ICONS.loading}${strings.loading}</span>` : html``);
		this.widgetElem.scrollTop = this.scrollTop;
		this.loadingElem.style.top = (this.scrollTop + (measureClientSize(this.widgetElem).height / 2) - 12) + 'px';
	}
}
