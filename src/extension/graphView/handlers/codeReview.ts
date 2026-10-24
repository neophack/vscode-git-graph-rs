import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import { notWired } from './context';
import type { Handler } from './context';

/** Code-review handlers (the review store lives in ExtensionState until task 4.5 ports it). */

export const startCodeReview: Handler<'startCodeReview'> = {
	mutates: MUTATING_COMMANDS.startCodeReview,
	handle: () => notWired('startCodeReview persists through ExtensionState, which is not a context port yet (task 4.5)')
};

export const updateCodeReview: Handler<'updateCodeReview'> = {
	mutates: MUTATING_COMMANDS.updateCodeReview,
	handle: () => notWired('updateCodeReview persists through ExtensionState, which is not a context port yet (task 4.5)')
};

export const endCodeReview: Handler<'endCodeReview'> = {
	mutates: MUTATING_COMMANDS.endCodeReview,
	handle: () => notWired('endCodeReview persists through ExtensionState, which is not a context port yet (task 4.5)')
};
