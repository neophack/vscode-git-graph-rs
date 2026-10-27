/* The form-input model of the dialogs (dialog.ts): the input kinds a dialog form can carry,
   their shape, and the values an action receives. A pure data module - the wiring lives in
   dialog.ts; extracted so the dialog stays under the 600-line gate (F3's additions). */

import { SelectOption } from '../state/store';

export const enum DialogInputType {
	Text,
	Textarea,
	TextRef,
	Select,
	Radio,
	Checkbox
}

export interface DialogTextareaInput {
	readonly type: DialogInputType.Textarea;
	readonly name: string;
	readonly default: string;
	readonly placeholder: string | null;
	readonly info?: string;
	readonly lines?: number;
}

export interface DialogTextInput {
	readonly type: DialogInputType.Text;
	readonly name: string;
	readonly default: string;
	readonly placeholder: string | null;
	readonly info?: string;
}

export interface DialogTextRefInput {
	readonly type: DialogInputType.TextRef;
	readonly name: string;
	readonly default: string;
	readonly info?: string;
}

export type DialogSelectInput = {
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

export interface DialogRadioInput {
	readonly type: DialogInputType.Radio;
	readonly name: string;
	readonly options: ReadonlyArray<SelectOption>;
	readonly default: string;
}

export interface DialogCheckboxInput {
	readonly type: DialogInputType.Checkbox;
	readonly name: string;
	readonly value: boolean;
	readonly info?: string;
}

export type DialogInput = DialogTextInput | DialogTextareaInput | DialogTextRefInput | DialogSelectInput | DialogRadioInput | DialogCheckboxInput;
export type DialogInputValue = string | string[] | boolean;
