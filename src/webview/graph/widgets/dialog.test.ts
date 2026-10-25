// @vitest-environment jsdom
/**
 * The dialog widget's reference-name validation (src/webview/graph/widgets/dialog.ts), ported
 * from tests/dialogValidationTooltip.test.mjs: while a TextRef input is invalid, hovering the
 * action button explains why through the shared help tooltip. Fixing the input from the keyboard
 * while the pointer stays on the button must remove that tooltip again: the hide path is the
 * delegated mouseout/focusout listener, which can no longer match the button once its
 * .gg-helpTooltip class has been cleared, so the validation code itself has to hide the visible
 * tooltip (and its aria-describedby).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { EventOverlay } from '../../common/eventOverlay';
import { observeHelpTooltips } from '../../common/helpTooltip';
import { Dialog, DialogInputType } from './dialog';

beforeEach(() => {
	document.body.textContent = '';
	observeHelpTooltips();
});

/** A dialog wired like the view wires it, over a single reference-name input. */
function makeRefInputDialog(actionName: string) {
	const dialog = new Dialog({
		eventOverlay: new EventOverlay(() => { }),
		closeDialogAndContextMenu: () => { },
		findCommitElem: () => null,
		getReferenceInputSpaceSubstitution: () => null
	});
	const submitted: string[][] = [];
	dialog.showForm('Create a branch', [
		{ type: DialogInputType.TextRef, name: '', default: '' }
	], actionName, (values) => { submitted.push(<string[]>values); }, null);
	return { dialog: dialog, submitted: submitted };
}

describe('the dialog validation tooltip', () => {
	it('is removed when the input becomes valid while the action button is hovered', () => {
		const { submitted } = makeRefInputDialog('Create Branch');
		const input = <HTMLInputElement>document.getElementById('dialogInput0');
		const action = document.getElementById('dialogAction')!;
		expect(input).not.toBe(null);
		expect(action).not.toBe(null);

		// An invalid reference arms the tooltip target on the action button; hovering shows it
		input.value = 'feature~bad';
		input.dispatchEvent(new Event('keyup', { bubbles: true }));
		expect(action.classList.contains('gg-helpTooltip')).toBe(true);

		action.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		const tooltip = document.getElementById('ggHelpTooltip');
		expect(tooltip).not.toBe(null);
		expect(tooltip!.textContent).toMatch(/invalid characters/);
		expect(action.getAttribute('aria-describedby')).toBe('ggHelpTooltip');

		// Focus never left the input, so the input can be fixed from the keyboard while the
		// pointer stays on the button
		input.value = 'feature';
		input.dispatchEvent(new Event('keyup', { bubbles: true }));
		expect(action.classList.contains('gg-helpTooltip')).toBe(false);

		// Moving the pointer away afterwards must leave nothing behind
		action.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));

		expect(document.getElementById('ggHelpTooltip')).toBe(null);
		expect(action.getAttribute('aria-describedby')).toBe(null);

		// The armed tooltip was the only thing keeping an invalid name from being submitted
		input.value = 'feature-ok';
		input.dispatchEvent(new Event('keyup', { bubbles: true }));
		action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(submitted).toEqual([['feature-ok']]);
	});

	it('blocks the action of an empty or invalid input (the dialog stays open, nothing submits)', () => {
		const { dialog, submitted } = makeRefInputDialog('Create Branch');
		const input = <HTMLInputElement>document.getElementById('dialogInput0');
		const action = document.getElementById('dialogAction')!;

		// Empty: flagged from the start (validateRefInput runs once when the form opens)
		input.dispatchEvent(new Event('keyup', { bubbles: true }));
		action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(submitted).toEqual([]);
		expect(dialog.isOpen()).toBe(true);

		input.value = 'bad..name';
		input.dispatchEvent(new Event('keyup', { bubbles: true }));
		action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(submitted).toEqual([]);
		expect(dialog.isOpen()).toBe(true);
	});
});
