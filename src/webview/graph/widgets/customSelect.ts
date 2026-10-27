import { alterClass, CLASS_FOCUSSED, CLASS_SELECTED, handledEvent } from '../../common/dom';
import { escapeHtml, html, setHtml } from '../../common/html';
import { strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { formatCommaSeparatedList } from '../../common/util';
import { SelectOption } from '../state/store';
import { Component } from '../component';
import { measureBoundingClientRect, measureClientSize, measureOffsetTop } from '../render/measure';

/** The data of a select input of a dialog. */
export type CustomSelectData = {
	readonly name: string;
	readonly options: ReadonlyArray<SelectOption>;
	readonly default: string;
	readonly multiple?: false;
} | {
	readonly name: string;
	readonly options: ReadonlyArray<SelectOption>;
	readonly defaults: ReadonlyArray<string>;
	readonly multiple: true;
};

/** Namespaces the options' ids (a dialog opens at most a handful of selects, one page at a time). */
let customSelectCount = 0;

/**
 * The custom select inputs used in dialogs (single or multiple selection, keyboard navigable).
 *
 * A select owns its outside-click capture listener for its whole lifetime (F3): `remove()`
 * — or any parent's dispose(), the dialog registers each select with itself — removes it, so
 * a dialog open/close cycle cannot leak a document-level handler per select. The open
 * options list is the surface: its listeners (option hover, mouse leave) are registered on
 * the surface store and removed together when the list closes.
 */
export class CustomSelect extends Component {
	private readonly data: CustomSelectData;
	private readonly selected: boolean[];
	private lastSelected: number = -1;
	private focussed: number = -1;
	private open: boolean;
	/** The prefix of the options' ids, referenced by the combobox's aria-activedescendant. */
	private readonly idBase: string;

	private dialogElem: HTMLElement | null;
	private elem: HTMLElement | null;
	private currentElem: HTMLElement | null;
	private optionsElem: HTMLElement | null = null;

	/**
	 * @param data The data configuring the select input.
	 * @param container The element to render the select input in.
	 * @param tabIndex The tabIndex of the select input.
	 * @param dialogElem The element of the dialog the select input is rendered in.
	 */
	constructor(data: CustomSelectData, container: HTMLElement, tabIndex: number, dialogElem: HTMLElement) {
		super(container);
		this.data = data;
		this.selected = data.options.map(() => false);
		this.open = false;
		this.dialogElem = dialogElem;
		// Unique across the page's lifetime (dialogs never coexist, but their ids must never be
		// reused while a stale element lingers in a fade-out): a module-level counter namespaces
		// the options' ids, which the combobox's aria-activedescendant points at
		this.idBase = 'customSelect' + (customSelectCount++).toString() + 'Option';

		container.className = 'customSelectContainer';
		this.elem = container;

		const currentElem = document.createElement('div');
		currentElem.className = 'customSelectCurrent';
		currentElem.tabIndex = tabIndex;
		// Combobox semantics (F5 accessibility): the closed control announces itself as a combobox
		// with the current value, the open list is its listbox, and the keyboard-highlighted option
		// (which keeps the focus on the combobox itself) is its aria-activedescendant
		currentElem.setAttribute('role', 'combobox');
		currentElem.setAttribute('aria-haspopup', 'listbox');
		currentElem.setAttribute('aria-expanded', 'false');
		if (data.name !== '') currentElem.setAttribute('aria-label', data.name);
		this.currentElem = currentElem;
		container.appendChild(currentElem);

		this.listen(document, 'click', (e: MouseEvent) => {
			if (!e.target) return;
			const targetElem = <HTMLElement>e.target;
			if (targetElem.closest('.customSelectContainer') !== this.elem && (this.optionsElem === null || targetElem.closest('.customSelectOptions') !== this.optionsElem)) {
				this.render(false);
				return;
			}

			if (targetElem.className === 'customSelectCurrent') {
				this.render(!this.open);
			} else if (this.open) {
				const optionElem = <HTMLElement | null>targetElem.closest('.customSelectOption');
				if (optionElem !== null) {
					const selectedOptionIndex = parseInt(optionElem.dataset.index!);
					this.setItemSelectedState(selectedOptionIndex, data.multiple ? !this.selected[selectedOptionIndex] : true);
					if (!this.data.multiple) {
						this.render(false);
					}
					if (this.currentElem !== null) {
						this.currentElem.focus();
					}
				}
			}
		}, true);

		this.listen(currentElem, 'keydown', (e) => {
			if (this.open && e.key === 'Tab') {
				this.render(false);
			} else if (this.open && (e.key === 'Enter' || e.key === 'Escape')) {
				this.render(false);
				handledEvent(e);
			} else if (this.data.multiple) {
				if (e.key === ' ' && this.focussed > -1) {
					this.setItemSelectedState(this.focussed, !this.selected[this.focussed]);
					handledEvent(e);
				} else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
					if (!this.open) {
						this.render(true);
					}
					this.setFocussed(this.focussed > 0 ? this.focussed - 1 : this.data.options.length - 1);
					this.scrollOptionIntoView(this.focussed);
					handledEvent(e);
				} else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
					if (!this.open) {
						this.render(true);
					}
					this.setFocussed(this.focussed < this.data.options.length - 1 ? this.focussed + 1 : 0);
					this.scrollOptionIntoView(this.focussed);
					handledEvent(e);
				}
			} else {
				if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
					this.setItemSelectedState(this.lastSelected > 0 ? this.lastSelected - 1 : this.data.options.length - 1, true);
					this.scrollOptionIntoView(this.lastSelected);
					handledEvent(e);
				} else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
					this.setItemSelectedState(this.lastSelected < this.data.options.length - 1 ? this.lastSelected + 1 : 0, true);
					this.scrollOptionIntoView(this.lastSelected);
					handledEvent(e);
				}
			}
		});

		if (data.multiple) {
			for (let i = data.options.length - 1; i >= 0; i--) {
				if (data.defaults.includes(data.options[i].value)) {
					this.setItemSelectedState(i, true);
				}
			}
		} else {
			const defaultIndex = data.options.findIndex((option) => option.value === data.default);
			this.setItemSelectedState(defaultIndex > -1 ? defaultIndex : 0, true);
		}
		this.renderCurrentValue();
	}

	/** Remove the select input, releasing everything linked to it. */
	public remove() {
		// dispose() (the component base, F3) removes the document-level click capture listener
		// and the open options list's listeners, so a removed select leaves nothing behind
		this.dispose();
		this.dialogElem = null;
		if (this.elem !== null) {
			this.elem.remove();
			this.elem = null;
		}
		if (this.currentElem !== null) {
			this.currentElem.remove();
			this.currentElem = null;
		}
		if (this.optionsElem !== null) {
			this.optionsElem.remove();
			this.optionsElem = null;
		}
	}

	/** The selected value (single selection) or values (multiple selection). */
	public getValue() {
		const values = this.data.options.map((option) => option.value).filter((_, index) => this.selected[index]);
		return this.data.multiple ? values : values[0];
	}

	private setItemSelectedState(index: number, state: boolean) {
		if (!this.data.multiple && this.lastSelected > -1) {
			this.selected[this.lastSelected] = false;
		}
		this.selected[index] = state;
		this.lastSelected = index;
		this.renderCurrentValue();
		this.renderOptionsStates();
	}

	private setFocussed(index: number) {
		if (this.focussed !== index) {
			if (this.focussed > -1) {
				const currentlyFocussedOption = this.getOptionElem(this.focussed);
				if (currentlyFocussedOption !== null) {
					alterClass(currentlyFocussedOption, CLASS_FOCUSSED, false);
				}
			}
			this.focussed = index;
			const newlyFocussedOption = this.getOptionElem(this.focussed);
			if (newlyFocussedOption !== null) {
				alterClass(newlyFocussedOption, CLASS_FOCUSSED, true);
			}
		}
		// The focus stays on the combobox while the list is open: point aria-activedescendant at
		// the highlighted option instead (or clear it when the pointer left the list)
		if (this.currentElem !== null) {
			if (index > -1) this.currentElem.setAttribute('aria-activedescendant', this.idBase + index.toString());
			else this.currentElem.removeAttribute('aria-activedescendant');
		}
	}

	private render(open: boolean) {
		if (this.elem === null || this.currentElem === null || this.dialogElem === null) return;

		if (this.open !== open) {
			this.open = open;
			this.currentElem.setAttribute('aria-expanded', open ? 'true' : 'false');
			if (open) {
				// A fresh list opens: the previous one's listeners went with its close, and any
				// straggler must not survive the element being replaced (F3)
				this.clearSurfaceListeners();
				if (this.optionsElem !== null) {
					this.optionsElem.remove();
				}
				this.optionsElem = document.createElement('div');
				const currentElemRect = measureBoundingClientRect(this.currentElem), dialogElemRect = measureBoundingClientRect(this.dialogElem);
				this.optionsElem.style.top = (currentElemRect.top - dialogElemRect.top + currentElemRect.height - 2) + 'px';
				this.optionsElem.style.left = (currentElemRect.left - dialogElemRect.left - 1) + 'px';
				this.optionsElem.style.width = currentElemRect.width + 'px';
				this.optionsElem.style.maxHeight = Math.max(measureClientSize(document.body).height - currentElemRect.top - currentElemRect.height - 2, 50) + 'px';
				this.optionsElem.className = 'customSelectOptions' + (this.data.multiple ? ' multiple' : '');
				this.optionsElem.setAttribute('role', 'listbox');
				if (this.data.multiple) this.optionsElem.setAttribute('aria-multiselectable', 'true');
				const icon = this.data.multiple ? html`<div class="selectedIcon">${SVG_ICONS.check}</div>` : '';
				setHtml(this.optionsElem, html`${this.data.options.map((option, index) =>
					html`<div class="customSelectOption" role="option" id="${this.idBase + index.toString()}" data-index="${index}">${icon}${option.name}</div>`
				)}`);
				// Surface-owned (F3): both go when the list closes (or the select is removed). The
				// option hover is ONE delegated listener on the list (its `data-index` options carry
				// the index), not one per option.
				this.listenOnSurface(this.optionsElem, 'mousemove', (e) => {
					if (!e.target) return;
					const elem = (<HTMLElement>e.target).closest('.customSelectOption');
					if (elem === null) return;
					this.setFocussed(parseInt((<HTMLElement>elem).dataset.index!));
				});
				this.listenOnSurface(this.optionsElem, 'mouseleave', () => this.setFocussed(-1));
				this.dialogElem.appendChild(this.optionsElem);
			} else {
				if (this.optionsElem !== null) {
					this.optionsElem.remove();
					this.optionsElem = null;
				}
				this.setFocussed(-1);
				// The list is gone: its listeners must not outlive it (F3)
				this.clearSurfaceListeners();
			}
			alterClass(this.elem, 'open', open);
		}

		if (open) {
			this.renderOptionsStates();
		}
	}

	private renderCurrentValue() {
		if (this.currentElem === null) return;
		const value = formatCommaSeparatedList(this.data.options.filter((_, index) => this.selected[index]).map((option) => option.name)) || strings.noneValue;
		this.currentElem.title = value;
		setHtml(this.currentElem, escapeHtml(value));
	}

	private renderOptionsStates() {
		if (this.optionsElem !== null) {
			const optionElems = this.optionsElem.children;
			for (let i = 0; i < optionElems.length; i++) {
				const elemIndex = parseInt((<HTMLElement>optionElems[i]).dataset.index!);
				alterClass(optionElems[i], CLASS_SELECTED, this.selected[elemIndex]);
				alterClass(optionElems[i], CLASS_FOCUSSED, this.focussed === elemIndex);
				(<HTMLElement>optionElems[i]).setAttribute('aria-selected', this.selected[elemIndex] ? 'true' : 'false');
			}
		}
	}

	private getOptionElem(index: number) {
		if (this.optionsElem !== null && index > -1) {
			const optionElems = this.optionsElem.children, indexStr = index.toString();
			for (let i = 0; i < optionElems.length; i++) {
				if ((<HTMLElement>optionElems[i]).dataset.index === indexStr) {
					return <HTMLElement>optionElems[i];
				}
			}
		}
		return null;
	}

	private scrollOptionIntoView(index: number) {
		const elem = this.getOptionElem(index);
		if (this.optionsElem !== null && elem !== null) {
			const elemOffsetTop = measureOffsetTop(elem), elemHeight = measureClientSize(elem).height;
			const optionsScrollTop = this.optionsElem.scrollTop, optionsHeight = measureClientSize(this.optionsElem).height;
			if (elemOffsetTop < optionsScrollTop) {
				this.optionsElem.scroll(0, elemOffsetTop);
			} else if (elemOffsetTop + elemHeight > optionsScrollTop + optionsHeight) {
				this.optionsElem.scroll(0, Math.max(elemOffsetTop + elemHeight - optionsHeight, 0));
			}
		}
	}
}
