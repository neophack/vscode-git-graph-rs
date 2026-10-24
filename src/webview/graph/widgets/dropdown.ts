import { alterClass, CLASS_SELECTED, handledEvent } from '../../common/dom';
import { escapeHtml, html, setHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { formatCommaSeparatedList } from '../../common/util';

export interface DropdownOption {
	readonly name: string;
	readonly value: string;
	readonly hint?: string;
	readonly title?: string;
}

/**
 * The dropdown inputs of the control bar (repository, branches, authors).
 */
export class Dropdown {
	private readonly showInfo: boolean;
	private readonly multipleAllowed: boolean;
	private readonly changeCallback: (values: string[]) => void;
	private readonly infoCallback: ((option: DropdownOption) => void) | null;

	private options: ReadonlyArray<DropdownOption> = [];
	private optionsSelected: boolean[] = [];
	private lastSelected: number = 0; // Only used when multipleAllowed === false
	private dropdownVisible: boolean = false;
	private lastClicked: number = 0;
	private doubleClickTimeout: number | null = null;
	private highlighted: number = -1; // The option currently highlighted by keyboard navigation (-1 => none)

	private readonly elem: HTMLElement;
	private readonly currentValueElem: HTMLDivElement;
	private readonly menuElem: HTMLDivElement;
	private readonly optionsElem: HTMLDivElement;
	private readonly noResultsElem: HTMLDivElement;
	private readonly filterInput: HTMLInputElement;

	/**
	 * @param elem The element the dropdown is rendered in.
	 * @param showInfo Should an information button be shown on the right of each option.
	 * @param multipleAllowed Can multiple options be selected (the first option is then "Show All").
	 * @param dropdownType The type of content the dropdown is used for (shown in the filter placeholder).
	 * @param changeCallback Invoked when the selected option(s) change.
	 * @param infoCallback Invoked when an option's information button is selected.
	 */
	constructor(elem: HTMLElement, showInfo: boolean, multipleAllowed: boolean, dropdownType: string, changeCallback: (values: string[]) => void, infoCallback: ((option: DropdownOption) => void) | null = null) {
		this.showInfo = showInfo;
		this.multipleAllowed = multipleAllowed;
		this.changeCallback = changeCallback;
		this.infoCallback = infoCallback;
		this.elem = elem;

		this.menuElem = document.createElement('div');
		this.menuElem.className = 'dropdownMenu';

		const filter = this.menuElem.appendChild(document.createElement('div'));
		filter.className = 'dropdownFilter';

		this.filterInput = filter.appendChild(document.createElement('input'));
		this.filterInput.className = 'dropdownFilterInput';
		this.filterInput.placeholder = formatStr(strings.filterDropdownPlaceholder, dropdownType);

		this.optionsElem = this.menuElem.appendChild(document.createElement('div'));
		this.optionsElem.className = 'dropdownOptions';

		this.noResultsElem = this.menuElem.appendChild(document.createElement('div'));
		this.noResultsElem.className = 'dropdownNoResults';
		setHtml(this.noResultsElem, escapeHtml(strings.dropdownNoResults));

		this.currentValueElem = this.elem.appendChild(document.createElement('div'));
		this.currentValueElem.className = 'dropdownCurrentValue';
		this.currentValueElem.tabIndex = 0;
		this.currentValueElem.setAttribute('role', 'button');

		alterClass(this.elem, 'multi', multipleAllowed);
		this.elem.appendChild(this.menuElem);

		document.addEventListener('click', (e) => {
			if (!e.target) return;
			if (e.target === this.currentValueElem) {
				if (this.dropdownVisible) {
					this.close();
				} else {
					this.open();
				}
			} else if (this.dropdownVisible) {
				if ((<HTMLElement>e.target).closest('.dropdown') !== this.elem) {
					this.close();
				} else {
					const info = (<HTMLElement>e.target).closest('.dropdownOptionInfo');
					if (info !== null && info.parentNode !== null && info.parentNode.parentNode === this.optionsElem && typeof (<HTMLElement>info.parentNode).dataset.id !== 'undefined') {
						const optionIndex = parseInt((<HTMLElement>info.parentNode).dataset.id!, 10);
						e.preventDefault();
						e.stopPropagation();
						if (this.infoCallback !== null && optionIndex >= 0 && optionIndex < this.options.length) {
							this.close();
							this.infoCallback(this.options[optionIndex]);
						}
						return;
					}
					const option = <HTMLElement | null>(<HTMLElement>e.target).closest('.dropdownOption');
					if (option !== null && option.parentNode === this.optionsElem && typeof option.dataset.id !== 'undefined') {
						this.onOptionClick(parseInt(option.dataset.id!));
					}
				}
			}
		}, true);
		document.addEventListener('contextmenu', () => this.close(), true);
		this.currentValueElem.addEventListener('keydown', (e) => {
			if (!this.dropdownVisible && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
				// Open the dropdown from the keyboard, without requiring a mouse click
				this.open();
				handledEvent(e);
			}
		});
		this.filterInput.addEventListener('keyup', (e) => {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab') {
				// These keys are handled entirely on keydown below (they navigate/select rather than
				// change the filter text); re-running filter() on their keyup would reset
				// this.highlighted back to -1 right after keydown set it, leaving the option looking
				// highlighted but Enter unable to select it
				return;
			}
			this.filter();
		});
		this.filterInput.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				this.moveHighlighted(e.key === 'ArrowDown' ? 1 : -1);
				handledEvent(e);
			} else if (e.key === 'Enter' && this.highlighted > -1) {
				this.onOptionClick(this.highlighted);
				handledEvent(e);
			} else if (e.key === 'Tab') {
				// Closing on Tab (rather than leaving the menu open behind the next focused element)
				// keeps the visible UI consistent with which control currently has focus
				this.close();
			}
		});
	}

	/** Open the dropdown, ready for keyboard or mouse selection. */
	private open() {
		this.dropdownVisible = true;
		this.elem.classList.add('dropdownOpen');
		this.filterInput.value = '';
		this.filter();
		// Start keyboard navigation from the currently selected option, and scroll it into view
		// so opening a long list (e.g. branches) doesn't strand the selection off-screen
		if (!this.multipleAllowed) this.setHighlighted(this.lastSelected);
		this.filterInput.focus();
	}

	/**
	 * Set the options of the dropdown.
	 * @param options The options to display.
	 * @param optionsSelected The values of the selected options.
	 */
	public setOptions(options: ReadonlyArray<DropdownOption>, optionsSelected: ReadonlyArray<string> | null) {
		this.options = options;
		this.optionsSelected = [];
		let selectedOption = -1, isSelected;
		if (optionsSelected) {
			for (let i = 0; i < options.length; i++) {
				isSelected = optionsSelected.includes(options[i].value);
				this.optionsSelected[i] = isSelected;
				if (isSelected) {
					selectedOption = i;
				}
			}
		}
		if (selectedOption === -1) {
			selectedOption = 0;
			this.optionsSelected[selectedOption] = true;
		}
		this.lastSelected = selectedOption;
		if (this.dropdownVisible && options.length <= 1) this.close();
		this.render();
		this.clearDoubleClickTimeout();
	}

	/** Is a value selected in the dropdown (respecting "Show All"). */
	public isSelected(value: string) {
		if (this.options.length > 0) {
			if (this.multipleAllowed && this.optionsSelected[0]) {
				// Multiple options can be selected, and "Show All" is selected.
				return true;
			}
			const optionIndex = this.options.findIndex((option) => option.value === value);
			if (optionIndex > -1 && this.optionsSelected[optionIndex]) {
				// The specific option is selected
				return true;
			}
		}
		return false;
	}

	/** Select a value (in addition to the selected ones) of a multiple selection dropdown. */
	public selectOption(value: string) {
		const optionIndex = this.options.findIndex((option) => value === option.value);
		if (this.multipleAllowed && optionIndex > -1 && !this.optionsSelected[0] && !this.optionsSelected[optionIndex]) {
			// Select the option with the specified value
			this.optionsSelected[optionIndex] = true;
			this.renderPreservingScroll();
			this.changeCallback(this.getSelectedOptions(false));
		}
	}

	/**
	 * Unselect every option and select only the option with the specified value. If the value isn't
	 * an option of this dropdown, nothing changes.
	 */
	public selectOnlyOption(value: string) {
		const optionIndex = this.options.findIndex((option) => value === option.value);
		if (optionIndex === -1 || (this.optionsSelected.length === 1 && this.optionsSelected[optionIndex])) return;

		this.optionsSelected = this.options.map((_, i) => i === optionIndex);
		this.lastSelected = optionIndex;
		this.renderPreservingScroll();
		this.changeCallback(this.getSelectedOptions(false));
	}

	/** Unselect a value of a multiple selection dropdown. */
	public unselectOption(value: string) {
		const optionIndex = this.options.findIndex((option) => value === option.value);
		if (this.multipleAllowed && optionIndex > -1 && (this.optionsSelected[0] || this.optionsSelected[optionIndex])) {
			if (this.optionsSelected[0]) {
				// Show All is currently selected, so unselect it, and select all branch options
				this.optionsSelected[0] = false;
				for (let i = 1; i < this.optionsSelected.length; i++) {
					this.optionsSelected[i] = true;
				}
			}

			// Unselect the option with the specified value
			this.optionsSelected[optionIndex] = false;
			if (this.optionsSelected.every((selected) => !selected)) {
				// All items have been unselected, select "Show All"
				this.optionsSelected[0] = true;
			}

			this.renderPreservingScroll();
			this.changeCallback(this.getSelectedOptions(false));
		}
	}

	/** Re-render the dropdown to apply style changes. */
	public refresh() {
		if (this.options.length > 0) this.render();
	}

	/** Is the dropdown open (its list of options visible). */
	public isOpen() {
		return this.dropdownVisible;
	}

	/** Close the dropdown. */
	public close() {
		this.elem.classList.remove('dropdownOpen');
		this.dropdownVisible = false;
		this.clearDoubleClickTimeout();
	}

	/** A change has occurred: re-render the options, keeping the scroll position of an open menu. */
	private renderPreservingScroll() {
		const menuScroll = this.menuElem.scrollTop;
		this.render();
		if (this.dropdownVisible) {
			this.menuElem.scroll(0, menuScroll);
		}
	}

	private render() {
		this.elem.classList.add('loaded');

		const curValueText = formatCommaSeparatedList(this.getSelectedOptions(true));
		this.currentValueElem.title = curValueText;
		setHtml(this.currentValueElem, escapeHtml(curValueText));

		setHtml(this.optionsElem, html`${this.options.map((option, i) => {
			// An option may carry a more descriptive text (e.g. a sub-repository's path relative
			// to its parent repository) to show on hover than the name displayed in the list
			const title = typeof option.title === 'string' && option.title !== '' ? option.title : option.name;
			return html`<div class="dropdownOption${this.optionsSelected[i] ? ' ' + CLASS_SELECTED : ''}" data-id="${i}" title="${title}">${this.multipleAllowed && this.optionsSelected[i] ? html`<div class="dropdownOptionMultiSelected">${SVG_ICONS.check}</div>` : ''}${option.name}${typeof option.hint === 'string' && option.hint !== '' ? html`<span class="dropdownOptionHint">${option.hint}</span>` : ''}${this.showInfo ? html`<button class="dropdownOptionInfo" type="button" title="${option.value}" aria-label="${formatStr(strings.dropdownOptionInfoLabel, option.name)}">${SVG_ICONS.info}</button>` : ''}</div>`;
		})}`);
		this.optionsElem.className = 'dropdownOptions' + (this.showInfo ? ' showInfo' : '');
		this.filterInput.style.display = 'none';
		this.noResultsElem.style.display = 'none';
		this.menuElem.style.cssText = 'opacity:0; display:block;';
		// Width must be at least 138px for the filter element.
		// Don't need to add 12px if showing (info icons or multi checkboxes) and the scrollbar isn't needed. The scrollbar isn't needed if: menuElem height + filter input (25px) < 297px
		const menuElemRect = this.menuElem.getBoundingClientRect();
		this.currentValueElem.style.width = Math.max(Math.ceil(menuElemRect.width) + ((this.showInfo || this.multipleAllowed) && menuElemRect.height < 272 ? 0 : 12), 138) + 'px';
		// Max height for the dropdown is [filter (31px) + 9.5 * dropdown item (28px) = 297px], clamped
		// so the menu never extends beyond the bottom of the view on short windows
		const maxMenuHeight = Math.max(Math.min(297, document.body.clientHeight - this.elem.getBoundingClientRect().bottom - 4), 90);
		this.menuElem.style.cssText = 'right:0; overflow-y:auto; max-height:' + maxMenuHeight + 'px;';
		if (this.dropdownVisible) this.filter();
	}

	/** Filter the displayed options by the text of the filter input. */
	private filter() {
		const val = this.filterInput.value.toLowerCase();
		let matches = false;
		for (let i = 0; i < this.options.length; i++) {
			const match = this.options[i].name.toLowerCase().indexOf(val) > -1;
			(<HTMLElement>this.optionsElem.children[i]).style.display = match ? 'block' : 'none';
			if (match) matches = true;
		}
		this.filterInput.style.display = 'block';
		this.noResultsElem.style.display = matches ? 'none' : 'block';
		this.highlighted = -1;
	}

	/** Move the keyboard highlight to the next/previous visible option, wrapping at either end. */
	private moveHighlighted(delta: number) {
		const visible = <HTMLElement[]>Array.prototype.filter.call(this.optionsElem.children, (elem: HTMLElement) => elem.style.display !== 'none');
		if (visible.length === 0) return;
		const curPos = this.highlighted === -1 ? -1 : visible.findIndex((elem) => parseInt(elem.dataset.id!) === this.highlighted);
		const newPos = curPos === -1 ? (delta > 0 ? 0 : visible.length - 1) : (curPos + delta + visible.length) % visible.length;
		this.setHighlighted(parseInt(visible[newPos].dataset.id!));
	}

	/** Highlight an option (keyboard navigation), scrolling it into view. */
	private setHighlighted(index: number) {
		if (this.highlighted > -1) {
			const prev = this.optionsElem.querySelector('[data-id="' + this.highlighted + '"]');
			if (prev !== null) prev.classList.remove('highlighted');
		}
		this.highlighted = index;
		const cur = this.optionsElem.querySelector('[data-id="' + index + '"]');
		if (cur !== null) {
			cur.classList.add('highlighted');
			cur.scrollIntoView({ block: 'nearest' });
		}
	}

	/**
	 * The selected options.
	 * @param names TRUE => their names, FALSE => their values.
	 */
	private getSelectedOptions(names: boolean) {
		const selected = [];
		if (this.multipleAllowed && this.optionsSelected[0]) {
			// Note: Show All is always the first option (0 index) when multiple selected items are allowed
			return [names ? this.options[0].name : this.options[0].value];
		}
		for (let i = 0; i < this.options.length; i++) {
			if (this.optionsSelected[i]) selected.push(names ? this.options[i].name : this.options[i].value);
		}
		return selected;
	}

	/** Select an option (a click or Enter), detecting double clicks. */
	private onOptionClick(option: number) {
		// Note: Show All is always the first option (0 index) when multiple selected items are allowed
		let change = false;
		const doubleClick = this.doubleClickTimeout !== null && this.lastClicked === option;
		if (this.doubleClickTimeout !== null) this.clearDoubleClickTimeout();

		if (doubleClick) {
			// Double click
			if (this.multipleAllowed && option === 0) {
				for (let i = 1; i < this.optionsSelected.length; i++) {
					this.optionsSelected[i] = !this.optionsSelected[i];
				}
				change = true;
			}
		} else {
			// Single Click
			if (this.multipleAllowed) {
				// Multiple dropdown options can be selected
				if (option === 0) {
					// Show All was selected
					if (!this.optionsSelected[0]) {
						this.optionsSelected[0] = true;
						for (let i = 1; i < this.optionsSelected.length; i++) {
							this.optionsSelected[i] = false;
						}
						change = true;
					}
				} else {
					if (this.optionsSelected[0]) {
						// Deselect "Show All" if it is enabled
						this.optionsSelected[0] = false;
					}

					this.optionsSelected[option] = !this.optionsSelected[option];

					if (this.optionsSelected.every((selected) => !selected)) {
						// All items have been unselected, select "Show All"
						this.optionsSelected[0] = true;
					}
					change = true;
				}
			} else {
				// Only a single dropdown option can be selected
				this.close();
				if (this.lastSelected !== option) {
					this.optionsSelected[this.lastSelected] = false;
					this.optionsSelected[option] = true;
					this.lastSelected = option;
					change = true;
				}
			}

			if (change) {
				// If a change has occurred, trigger the callback
				this.changeCallback(this.getSelectedOptions(false));
			}
		}

		if (change) {
			// If a change has occurred, re-render the dropdown elements
			this.renderPreservingScroll();
		}

		this.lastClicked = option;
		this.doubleClickTimeout = window.setTimeout(() => {
			this.clearDoubleClickTimeout();
		}, 500);
	}

	private clearDoubleClickTimeout() {
		if (this.doubleClickTimeout !== null) {
			window.clearTimeout(this.doubleClickTimeout);
			this.doubleClickTimeout = null;
		}
	}
}
