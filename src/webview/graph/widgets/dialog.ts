import { DATA_LOSS_WARNING_IMAGE } from '../../common/assets';
import { alterClass, removeClassFromAll } from '../../common/dom';
import { EventOverlay } from '../../common/eventOverlay';
import { hideHelpTooltip } from '../../common/helpTooltip';
import { helpTooltipAttrs, html, joinHtml, SafeHtml, setHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { ensureWidgetStyles } from '../../common/onDemandStyles';
import * as GG from '../../common/protocol';
import { REF_INVALID_REGEX } from '../../common/util';
import { SelectOption } from '../state/store';
import { CommitTarget, DialogTarget, RefTarget, TargetType } from '../state/types';
import { CustomSelect } from './customSelect';

const CLASS_DIALOG_ACTIVE = 'dialogActive';
const CLASS_DIALOG_INPUT_INVALID = 'inputInvalid';
const CLASS_DIALOG_NO_INPUT = 'noInput';

const enum DialogType {
	Form,
	ActionRunning,
	Message
}

export const enum DialogInputType {
	Text,
	Textarea,
	TextRef,
	Select,
	Radio,
	Checkbox
}

interface DialogTextareaInput {
	readonly type: DialogInputType.Textarea;
	readonly name: string;
	readonly default: string;
	readonly placeholder: string | null;
	readonly info?: string;
	readonly lines?: number;
}

interface DialogTextInput {
	readonly type: DialogInputType.Text;
	readonly name: string;
	readonly default: string;
	readonly placeholder: string | null;
	readonly info?: string;
}

interface DialogTextRefInput {
	readonly type: DialogInputType.TextRef;
	readonly name: string;
	readonly default: string;
	readonly info?: string;
}

type DialogSelectInput = {
	readonly type: DialogInputType.Select;
	readonly name: string;
	readonly options: ReadonlyArray<SelectOption>;
	readonly default: string;
	readonly multiple?: false;
	readonly info?: string;
} | {
	readonly type: DialogInputType.Select;
	readonly name: string;
	readonly options: ReadonlyArray<SelectOption>;
	readonly defaults: ReadonlyArray<string>;
	readonly multiple: true;
	readonly info?: string;
};

interface DialogRadioInput {
	readonly type: DialogInputType.Radio;
	readonly name: string;
	readonly options: ReadonlyArray<SelectOption>;
	readonly default: string;
}

interface DialogCheckboxInput {
	readonly type: DialogInputType.Checkbox;
	readonly name: string;
	readonly value: boolean;
	readonly info?: string;
}

export type DialogInput = DialogTextInput | DialogTextareaInput | DialogTextRefInput | DialogSelectInput | DialogRadioInput | DialogCheckboxInput;
export type DialogInputValue = string | string[] | boolean;

/** The content of a dialog: markup, or text (escaped). */
export type DialogMessage = SafeHtml | string;

/** What a dialog needs from the rest of the view. */
export interface DialogDeps {
	readonly eventOverlay: EventOverlay;
	/** Close the dialog and the context menu (before a new dialog opens). */
	closeDialogAndContextMenu(): void;
	/** Resolve the rendered row of the commit at an index (NULL if it isn't rendered). */
	findCommitElem(index: number): HTMLElement | null;
	/** The space substitution of reference name inputs (Extension Setting), or NULL. */
	getReferenceInputSpaceSubstitution(): string | null;
}

/**
 * The Git Graph View's dialogs.
 */
export class Dialog {
	private elem: HTMLElement | null = null;
	private target: DialogTarget | null = null;
	private actioned: (() => void) | null = null;
	private type: DialogType | null = null;
	private customSelects: { [inputIndex: string]: CustomSelect } = {};

	private static readonly WHITESPACE_REGEXP = /\s/gu;

	constructor(private readonly deps: DialogDeps) { }

	/**
	 * Show a confirmation dialog.
	 * @param message What the user is asked to confirm.
	 * @param actionName The name of the affirmative action (e.g. "Yes, <verb>").
	 * @param actioned Invoked if the user takes the affirmative action.
	 * @param target The target the dialog was opened on.
	 */
	public showConfirmation(message: DialogMessage, actionName: string, actioned: () => void, target: DialogTarget | null) {
		this.show(DialogType.Form, message, actionName, strings.dialogCancel, () => {
			if (this.elem === null) return; // already closed: a re-activation of the fading dialog's button must not run the action again
			this.close();
			actioned();
		}, null, target);
	}

	/**
	 * Show a dialog presenting two options.
	 */
	public showTwoButtons(message: DialogMessage, buttonLabel1: string, buttonAction1: () => void, buttonLabel2: string, buttonAction2: () => void, target: DialogTarget | null) {
		this.show(DialogType.Form, message, buttonLabel1, buttonLabel2, () => {
			if (this.elem === null) return; // already closed (see showConfirmation)
			this.close();
			buttonAction1();
		}, () => {
			if (this.elem === null) return;
			this.close();
			buttonAction2();
		}, target);
	}

	/**
	 * Show a dialog asking for the name of a Git reference (validated before it can be actioned).
	 */
	public showRefInput(message: DialogMessage, defaultValue: string, actionName: string, actioned: (value: string) => void, target: DialogTarget | null) {
		this.showForm(message, [
			{ type: DialogInputType.TextRef, name: '', default: defaultValue }
		], actionName, (values) => actioned(<string>values[0]), target);
	}

	/** Show a dialog with a single checkbox input. */
	public showCheckbox(message: DialogMessage, checkboxLabel: string, checkboxValue: boolean, actionName: string, actioned: (value: boolean) => void, target: DialogTarget | null) {
		this.showForm(message, [
			{ type: DialogInputType.Checkbox, name: checkboxLabel, value: checkboxValue }
		], actionName, (values) => actioned(<boolean>values[0]), target);
	}

	/** Show a dialog with a single select input. */
	public showSelect(message: DialogMessage, defaultValue: string, options: ReadonlyArray<SelectOption>, actionName: string, actioned: (value: string) => void, target: DialogTarget | null) {
		this.showForm(message, [
			{ type: DialogInputType.Select, name: '', options: options, default: defaultValue }
		], actionName, (values) => actioned(<string>values[0]), target);
	}

	/** Show a dialog with a single multi-select input. */
	public showMultiSelect(message: DialogMessage, defaultValues: ReadonlyArray<string>, options: ReadonlyArray<SelectOption>, actionName: string, actioned: (value: string[]) => void, target: DialogTarget | null) {
		this.showForm(message, [
			{ type: DialogInputType.Select, name: '', options: options, defaults: defaultValues, multiple: true }
		], actionName, (values) => actioned(<string[]>values[0]), target);
	}

	/**
	 * Show a dialog with any number of form inputs.
	 * @param message The purpose of the dialog.
	 * @param inputs The form inputs.
	 * @param actionName The name of the primary action.
	 * @param actioned Invoked with the form values when the primary action is triggered.
	 * @param target The target the dialog was opened on.
	 * @param secondaryActionName The name of the secondary action.
	 * @param secondaryActioned Invoked with the form values when the secondary action is triggered (NULL => it closes the dialog).
	 * @param includeLineBreak Should a line break separate the message and the form inputs.
	 */
	public showForm(message: DialogMessage, inputs: ReadonlyArray<DialogInput>, actionName: string, actioned: (values: DialogInputValue[]) => void, target: DialogTarget | null, secondaryActionName: string = strings.dialogCancel, secondaryActioned: ((values: DialogInputValue[]) => void) | null = null, includeLineBreak: boolean = true) {
		const multiElement = inputs.length > 1;
		const multiCheckbox = multiElement && inputs.every((input) => input.type === DialogInputType.Checkbox);
		const infoColRequired = inputs.some((input) => input.type !== DialogInputType.Checkbox && input.type !== DialogInputType.Radio && input.info);
		const inputRows = inputs.map((input, id) => {
			let inputHtml: SafeHtml;
			if (input.type === DialogInputType.Radio) {
				inputHtml = html`<td class="inputCol"${infoColRequired ? html` colspan="2"` : ''}><span class="dialogFormRadio">${joinHtml(input.options.map((option, optionId) =>
					html`<label><input type="radio" name="dialogInput${id}" value="${optionId}"${option.value === input.default ? html` checked` : ''} tabindex="${id + 1}"/><span class="customRadio"></span>${option.name}</label>`
				), html`<br>`)}</span></td>`;
			} else {
				const infoHtml = input.info ? html`<span ${helpTooltipAttrs(input.info, 'dialogInfo')}>${SVG_ICONS.info}</span>` : '';
				const infoCol = infoColRequired ? html`<td>${infoHtml}</td>` : '';
				if (input.type === DialogInputType.Select) {
					inputHtml = html`<td class="inputCol"><div id="dialogFormSelect${id}"></div></td>${infoCol}`;
				} else if (input.type === DialogInputType.Checkbox) {
					inputHtml = html`<td class="inputCol"${infoColRequired ? html` colspan="2"` : ''}><span class="dialogFormCheckbox"><label><input id="dialogInput${id}" type="checkbox"${input.value ? html` checked` : ''} tabindex="${id + 1}"/><span class="customCheckbox"></span>${multiElement && !multiCheckbox ? '' : input.name}</label>${infoHtml}</span></td>`;
				} else if (input.type === DialogInputType.Textarea) {
					inputHtml = html`<td class="inputCol"><textarea id="dialogInput${id}"${input.placeholder !== null ? html` placeholder="${input.placeholder}"` : ''} tabindex="${id + 1}" rows="${input.lines || 4}" style="resize:vertical;width:100%;font-family:inherit;padding:4px;box-sizing:border-box;margin-top:2px;">${input.default}</textarea></td>${infoCol}`;
				} else {
					inputHtml = html`<td class="inputCol"><input id="dialogInput${id}" type="text" value="${input.default}"${input.type === DialogInputType.Text && input.placeholder !== null ? html` placeholder="${input.placeholder}"` : ''} tabindex="${id + 1}"/></td>${infoCol}`;
				}
			}
			return html`<tr${input.type === DialogInputType.Radio ? html` class="mediumField"` : input.type !== DialogInputType.Checkbox ? html` class="largeField"` : ''}>${multiElement && !multiCheckbox ? html`<td>${input.name}: </td>` : ''}${inputHtml}</tr>`;
		});

		const content = inputs.length > 0
			? html`${message}${includeLineBreak ? html`<br>` : ''}<table class="dialogForm ${multiElement ? multiCheckbox ? 'multiCheckbox' : 'multi' : 'single'}">${inputRows}</table>`
			: html`${message}`;

		const areFormValuesInvalid = () => this.elem === null || this.elem.classList.contains(CLASS_DIALOG_NO_INPUT) || this.elem.classList.contains(CLASS_DIALOG_INPUT_INVALID);
		const getFormValues = () => inputs.map((input, index) => {
			if (input.type === DialogInputType.Radio) {
				// Iterate through all of the radio options to get the checked value
				const elems = <NodeListOf<HTMLInputElement>>document.getElementsByName('dialogInput' + index);
				for (let i = 0; i < elems.length; i++) {
					if (elems[i].checked) {
						return input.options[parseInt(elems[i].value)].value;
					}
				}
				return input.default; // If no option is checked, return the default value
			} else if (input.type === DialogInputType.Select) {
				return this.customSelects[index.toString()].getValue();
			} else {
				const elem = <HTMLInputElement>document.getElementById('dialogInput' + index);
				return input.type === DialogInputType.Checkbox
					? elem.checked // Checkboxes return a boolean indicating if the value is checked
					: elem.value; // All other fields return the value as a string
			}
		});

		this.show(DialogType.Form, content, actionName, secondaryActionName, () => {
			if (areFormValuesInvalid()) return;
			const values = getFormValues();
			this.close();
			actioned(values);
		}, secondaryActioned !== null ? () => {
			if (areFormValuesInvalid()) return;
			const values = getFormValues();
			this.close();
			secondaryActioned(values);
		} : null, target);

		// Create custom select inputs
		inputs.forEach((input, index) => {
			if (input.type === DialogInputType.Select) {
				this.customSelects[index.toString()] = new CustomSelect(input, document.getElementById('dialogFormSelect' + index)!, index + 1, this.elem!);
			}
		});

		// If the dialog contains a TextRef input, attach event listeners for validation
		const textRefInput = inputs.findIndex((input) => input.type === DialogInputType.TextRef);
		if (textRefInput > -1) {
			const dialogInput = <HTMLInputElement>document.getElementById('dialogInput' + textRefInput), dialogAction = document.getElementById('dialogAction')!;
			if (dialogInput.value === '') this.elem!.classList.add(CLASS_DIALOG_NO_INPUT);
			const validateRefInput = () => {
				if (this.elem === null) return;
				const spaceSubstitution = this.deps.getReferenceInputSpaceSubstitution();
				if (spaceSubstitution !== null) {
					const selectionStart = dialogInput.selectionStart, selectionEnd = dialogInput.selectionEnd;
					dialogInput.value = dialogInput.value.replace(Dialog.WHITESPACE_REGEXP, spaceSubstitution);
					dialogInput.selectionStart = selectionStart;
					dialogInput.selectionEnd = selectionEnd;
				}
				const noInput = dialogInput.value === '', invalidInput = dialogInput.value.match(REF_INVALID_REGEX) !== null;
				alterClass(this.elem, CLASS_DIALOG_NO_INPUT, noInput);
				if (alterClass(this.elem, CLASS_DIALOG_INPUT_INVALID, !noInput && invalidInput)) {
					const validationMessage = invalidInput ? formatStr(strings.dialogUnableToAction, actionName) : '';
					dialogAction.title = '';
					if (validationMessage !== '') {
						dialogAction.classList.add('gg-helpTooltip');
						dialogAction.dataset.tooltip = validationMessage;
						dialogAction.setAttribute('aria-label', validationMessage);
					} else {
						hideHelpTooltip();
						dialogAction.classList.remove('gg-helpTooltip');
						delete dialogAction.dataset.tooltip;
						dialogAction.removeAttribute('aria-label');
					}
				}
			};
			// 'input' catches a value pasted with the mouse (keyup never fires for it) and 'keyup'
			// keeps parity with the keyboard-driven flow; both run the same validation. It also
			// runs once now, so an invalid pre-filled default is flagged from the start.
			dialogInput.addEventListener('input', validateRefInput);
			dialogInput.addEventListener('keyup', validateRefInput);
			validateRefInput();
		}

		if (inputs.length > 0 && (inputs[0].type === DialogInputType.Text || inputs[0].type === DialogInputType.TextRef)) {
			// If the first input is a text field, set focus to it.
			(<HTMLInputElement>document.getElementById('dialogInput0')).focus();
		}
	}

	/** Show a message in a dialog. */
	public showMessage(message: DialogMessage) {
		this.show(DialogType.Message, message, null, strings.dialogClose, null, null, null);
	}

	/**
	 * Replace the dialog's bottom Close button with an ✕ icon in the top-right corner of the dialog.
	 * Must be called after the dialog content has been rendered (e.g. directly after showMessage).
	 */
	public useCloseIcon() {
		if (this.elem === null) return;
		const secondaryAction = document.getElementById('dialogSecondaryAction');
		if (secondaryAction !== null) secondaryAction.style.display = 'none';
		const closeIcon = document.createElement('span');
		closeIcon.id = 'dialogCloseIcon';
		closeIcon.title = strings.dialogClose;
		setHtml(closeIcon, SVG_ICONS.close);
		closeIcon.addEventListener('click', () => this.close());
		this.elem.appendChild(closeIcon);
	}

	/**
	 * Register a click handler on every element of the open dialog matching a selector. Must be
	 * called after the dialog content has been rendered (e.g. directly after showMessage).
	 */
	public onClick(selector: string, handler: (elem: HTMLElement) => void) {
		if (this.elem === null) return;
		const elems = this.elem.querySelectorAll<HTMLElement>(selector);
		for (let i = 0; i < elems.length; i++) {
			const elem = elems[i];
			elem.addEventListener('click', (event) => {
				event.stopPropagation();
				handler(elem);
			});
		}
	}

	/**
	 * Show an error.
	 * @param message The high-level category of the error.
	 * @param reason The error details.
	 * @param actionName The name of a primary action (if one is required).
	 * @param actioned Invoked when the primary action is triggered.
	 */
	public showError(message: DialogMessage, reason: GG.ErrorInfo, actionName: string | null, actioned: (() => void) | null) {
		this.show(DialogType.Message, html`<span class="dialogAlert">${SVG_ICONS.alert}${strings.dialogErrorPrefix}${message}</span>${reason !== null ? html`<br><span class="messageContent errorContent">${joinHtml(reason.split('\n'), html`<br>`)}</span>` : ''}`, actionName, strings.dialogDismiss, () => {
			this.close();
			if (actioned !== null) actioned();
		}, null, null);
	}

	/**
	 * Show a warning about an operation that can lose data, which the user must explicitly accept
	 * before the operation is performed.
	 * @param risk The data loss risk of the operation.
	 * @param actioned Invoked if the user accepts the risk.
	 */
	public showDataLossWarning(risk: DialogMessage, actioned: () => void) {
		this.show(DialogType.Form,
			html`<span class="dialogAlert warning">${SVG_ICONS.alert}${strings.dataLossDialogTitle}</span><br><span class="messageContent">${risk}</span><div class="dataLossMascot"><img src="${DATA_LOSS_WARNING_IMAGE}" alt="${strings.dataLossDialogTitle}"><div class="dataLossMascotCaption">${strings.dataLossMascotCaption}</div></div>`,
			strings.dataLossContinue, strings.dialogCancel, () => {
				this.close();
				actioned();
			}, null, null);
	}

	/** Show the dialog indicating that an action is running. */
	public showActionRunning(action: string) {
		this.show(DialogType.ActionRunning, html`<span class="actionRunning">${SVG_ICONS.loading}${action} ...</span>`, null, strings.dialogDismiss, null, null, null);
	}

	private show(type: DialogType, message: DialogMessage, actionName: string | null, secondaryActionName: string, actioned: (() => void) | null, secondaryActioned: (() => void) | null, target: DialogTarget | null) {
		// The dialog styles are on demand (task 5.9's CSS split): kick their chunk so the first
		// dialog of a session is styled as soon as the (idle-prefetched) chunk arrives
		ensureWidgetStyles(() => import('../../styles/onDemand'));
		this.deps.closeDialogAndContextMenu();
		// A dialog being replaced is fading out: remove it immediately so it doesn't overlap the new one
		const closing = document.querySelectorAll('.dialog.closing');
		for (let i = 0; i < closing.length; i++) closing[i].remove();

		this.type = type;
		this.target = target;
		this.deps.eventOverlay.create('dialogBacking', null, null);

		const dialog = document.createElement('div'), dialogContent = document.createElement('div');
		dialog.className = 'dialog';
		dialogContent.className = 'dialogContent';
		setHtml(dialogContent, html`${message}<br>${actionName !== null ? html`<div id="dialogAction" class="roundedBtn" role="button" tabindex="0">${actionName}</div>` : ''}<div id="dialogSecondaryAction" class="roundedBtn" role="button" tabindex="0">${secondaryActionName}</div>`);
		dialog.appendChild(dialogContent);
		this.elem = dialog;
		document.body.appendChild(dialog);

		const docHeight = document.body.clientHeight;
		let dialogHeight = dialog.clientHeight + 2;
		if (type !== DialogType.Form && dialogHeight > 0.8 * docHeight) {
			dialogContent.style.height = Math.round(0.8 * docHeight - 22) + 'px';
			dialogHeight = Math.round(0.8 * docHeight);
		}
		dialog.style.top = Math.max(Math.round((docHeight - dialogHeight) / 2), 10) + 'px';
		if (actionName !== null && actioned !== null) {
			document.getElementById('dialogAction')!.addEventListener('click', actioned);
			this.actioned = actioned;
		}
		document.getElementById('dialogSecondaryAction')!.addEventListener('click', secondaryActioned !== null ? secondaryActioned : () => this.close());

		if (this.target !== null && this.target.type !== TargetType.Repo) {
			alterClass(this.target.elem, CLASS_DIALOG_ACTIVE, true);
		}
	}

	/** Close the dialog (if one is open). */
	public close() {
		this.deps.eventOverlay.remove();
		if (this.elem !== null) {
			const elem = this.elem;
			// The buttons stay in the DOM for the closing fade: take focus off them, so a
			// Space/Enter pressed right after the click cannot re-activate the old handler
			// (keyboard activation bypasses the fade's pointer-events: none).
			if (document.activeElement instanceof HTMLElement && elem.contains(document.activeElement)) document.activeElement.blur();
			elem.classList.add('closing');
			window.setTimeout(() => elem.remove(), 180);
			this.elem = null;
		}
		removeClassFromAll(document, CLASS_DIALOG_ACTIVE);
		this.target = null;
		Object.keys(this.customSelects).forEach((index) => this.customSelects[index].remove());
		this.customSelects = {};
		this.actioned = null;
		this.type = null;
	}

	/** Close the "action running" dialog (if it is the one open). */
	public closeActionRunning() {
		if (this.type === DialogType.ActionRunning) this.close();
	}

	/** Submit the primary action of the dialog. */
	public submit() {
		if (this.actioned !== null) this.actioned();
	}

	/**
	 * Refresh the dialog after the commits were re-rendered: a dialog with a dynamic target is
	 * re-linked to the target's new element, or closed when the target is no longer rendered.
	 * @param commits The commits now rendered.
	 */
	public refresh(commits: ReadonlyArray<GG.GitCommit>) {
		if (!this.isOpen() || this.target === null || this.target.type === TargetType.Repo) {
			// Don't need to refresh if: no dialog is open, it is not dynamic, or it is not reliant on commit changes
			return;
		}

		const commitIndex = commits.findIndex((commit) => commit.hash === (<CommitTarget | RefTarget>this.target).hash);
		if (commitIndex > -1) {
			// The commit still exists
			const commitElem = this.deps.findCommitElem(commitIndex);
			if (commitElem !== null) {
				if (typeof this.target.ref === 'undefined') {
					// Dialog is only dependent on the commit itself
					if (this.target.type !== TargetType.CommitDetailsView) {
						this.target.elem = commitElem;
						alterClass(this.target.elem, CLASS_DIALOG_ACTIVE, true);
					}
					return;
				} else {
					// Dialog is dependent on the commit and ref
					const elems = commitElem.querySelectorAll<HTMLElement>('[data-fullref]');
					for (let i = 0; i < elems.length; i++) {
						if (elems[i].dataset.fullref! === this.target.ref) {
							this.target.elem = this.target.type === TargetType.Ref ? elems[i] : commitElem;
							alterClass(this.target.elem, CLASS_DIALOG_ACTIVE, true);
							return;
						}
					}
				}
			}
		}

		this.close();
	}

	/** Is a dialog open. */
	public isOpen() {
		return this.elem !== null;
	}

	/** Is the target of the open dialog dynamic (tied to a commit row of the view). */
	public isTargetDynamicSource() {
		return this.isOpen() && this.target !== null;
	}
}
