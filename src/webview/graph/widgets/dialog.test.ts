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

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventOverlay } from '../../common/eventOverlay';
import { observeHelpTooltips } from '../../common/helpTooltip';
import { Dialog, DialogInputType } from './dialog';

// The viewport and dialog heights the sizing maths reads (jsdom boxes all measure 0; the two
// controllable values let a test open a dialog that overshoots the 80%-of-viewport cap).
const sizes = vi.hoisted(() => ({ body: 0, dialog: 0 }));

vi.mock('../render/measure', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../render/measure')>();
	return {
		...actual,
		measureClientSize: (elem: Element) => ({
			width: elem.clientWidth,
			height: elem === document.body ? sizes.body : elem.classList.contains('dialog') ? sizes.dialog : elem.clientHeight
		})
	};
});

beforeEach(() => {
	document.body.textContent = '';
	sizes.body = 0;
	sizes.dialog = 0;
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

/** A dialog wired like the view wires it, showing a plain message. */
function makeMessageDialog(message: string) {
	const dialog = new Dialog({
		eventOverlay: new EventOverlay(() => { }),
		closeDialogAndContextMenu: () => { },
		findCommitElem: () => null,
		getReferenceInputSpaceSubstitution: () => null
	});
	dialog.showMessage(message);
	return dialog;
}

describe('the message dialog sizing', () => {
	it('caps a dialog taller than the viewport with a max-height the content can shrink under', () => {
		sizes.body = 500;
		sizes.dialog = 600; // the natural height overshoots the 80%-of-viewport cap
		const dialog = makeMessageDialog('a tall message');

		const content = <HTMLElement>document.querySelector('.dialogContent')!;
		// 0.8 * 500 - 22
		expect(content.style.maxHeight).toBe('378px');
		// No fixed height: when the content is restyled shorter after the measurement (the
		// dialog's first open races the on-demand widget styles), the dialog must shrink with
		// it instead of keeping the measured height as a blank area above its bottom edge
		expect(content.style.height).toBe('');

		dialog.close();
	});

	it('leaves no blank line behind where the Close button was replaced by the close icon', () => {
		const dialog = makeMessageDialog('the message');
		dialog.useCloseIcon();

		expect(document.getElementById('dialogSecondaryAction')!.style.display).toBe('none');
		const closeIcon = document.getElementById('dialogCloseIcon');
		expect(closeIcon).not.toBe(null);
		// The line break that separated the content from the hidden Close button must go with it
		const breaks = Array.from(document.querySelector('.dialogContent')!.children).filter((child) => child.tagName === 'BR');
		expect(breaks).toEqual([]);

		closeIcon!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(dialog.isOpen()).toBe(false);
	});
});
