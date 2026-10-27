/* The commit author identity model of the Settings Widget: the identities of the
   `git-graph-rs.commitAuthors` Extension Setting, which of them is the global author, the dialog
   that manages them, and the one-shot seeding of the first identity from the global Git
   configuration. Both columns render this model (the Repository column applies an identity to
   the repository, the Global Settings column manages the list), so it lives beside them rather
   than inside either. */

import { strings } from '../../../common/i18n/index';
import * as GG from '../../../common/protocol';
import { GraphContext } from '../../context';
import { DialogInputType } from '../dialog';
import { saveGlobalSetting } from './settingsHost';

/** The author identities of the `git-graph-rs.commitAuthors` Extension Setting as a writeable copy, ready to be modified and saved back. */
export function getCommitAuthors(ctx: GraphContext): GG.CommitAuthor[] {
	return ctx.store.config.commitAuthors.map((author) => ({ name: author.name, email: author.email }));
}

/**
 * The index of the author identity that is the global author: the identity the global Git
 * configuration matches or - when it matches none - the FIRST identity (the default), so
 * repositories following the global configuration always have a well-defined author. The
 * default is materialised into the global Git configuration by the extension host whenever
 * the identity list is saved, and can be changed with the check button of any author.
 */
export function getGlobalAuthorIndex(authors: ReadonlyArray<GG.CommitAuthor>, config: Readonly<GG.GitRepoConfig> | null) {
	if (config === null) return -1;
	const name = config.user.name.global, email = config.user.email.global;
	const matched = authors.findIndex((author) => name === author.name && email === author.email);
	return matched >= 0 ? matched : authors.length > 0 ? 0 : -1;
}

/**
 * Save the author identities of the `git-graph-rs.commitAuthors` Extension Setting. The
 * extension host may default the global author to the first identity while saving (writing
 * the global Git configuration), or clear the global author when the list is emptied; the
 * save's response tells the view to reload the repository configuration once those writes
 * have completed, and the fresh snapshot re-renders the Settings Widget. A reload issued HERE
 * would race the save's Git writes and render the pre-save global author. Values the setting
 * rejects (e.g. an empty name or email) are reported through the save action's response dialog.
 */
export function saveCommitAuthors(ctx: GraphContext, authors: GG.CommitAuthor[]) {
	// The list the widget rendered is what the global-author side effects of the save are
	// judged against on the host: deleting the last identity clears the global author it
	// held, even when the host's own configuration read has not caught up with the editor.
	saveGlobalSetting(ctx, 'commitAuthors', authors, getCommitAuthors(ctx));
}

/** The index of the author identity a settings widget element event belongs to. */
export function getAuthorIndexForBtnEvent(e: Event) {
	return parseInt((<HTMLElement>(<Element>e.target).closest('[data-index]')!).dataset.index!);
}

/** Show the dialog for adding (index -1) or editing (index of the author) an author identity. */
export function showAuthorDialog(ctx: GraphContext, index: number) {
	const authors = getCommitAuthors(ctx);
	const author = index >= 0 && index < authors.length ? authors[index] : null;
	ctx.dialog.showForm(author !== null ? strings.settingsEditAuthorDialogMessage : strings.settingsAddAuthorDialogMessage, [
		{ type: DialogInputType.Text, name: strings.settingsAuthorNameInput, default: author !== null ? author.name : '', placeholder: null },
		{ type: DialogInputType.Text, name: strings.settingsAuthorEmailInput, default: author !== null ? author.email : '', placeholder: null }
	], strings.settingsSaveAuthor, (values) => {
		const name = (<string>values[0]).trim(), email = (<string>values[1]).trim();
		if (author !== null && author.name === name && author.email === email) return; // unchanged
		const next = getCommitAuthors(ctx);
		if (author !== null) {
			next[index] = { name: name, email: email };
		} else {
			next.push({ name: name, email: email });
		}
		saveCommitAuthors(ctx, next);
	}, null);
}

/**
 * While the `git-graph-rs.commitAuthors` Extension Setting is empty, the author list shown
 * by the widget is seeded from the identity already configured in the global Git
 * configuration (user.name/user.email): that identity becomes the first author - and
 * therefore the global author - so adding further identities can never silently replace
 * it. An empty list means "follow what Git already has"; Git having no complete global
 * identity leaves the list empty until the user configures one.
 *
 * The seeding is one-shot (`seed` is the widget's own guard): it is attempted at most once
 * per widget, and never once the list has held any identity. Saving the setting re-loads
 * the configuration, which synchronously re-renders the widget before the saved setting is
 * visible, so re-running the seeding would recurse without end - and a list the user emptied
 * deliberately must stay empty instead of being re-seeded with the global identity.
 */
export function maybeSeedCommitAuthors(ctx: GraphContext, config: Readonly<GG.GitRepoConfig> | null, seed: { attempted: boolean }) {
	if (seed.attempted) return;
	if (config === null) return;
	if (ctx.store.config.commitAuthors.length > 0) {
		// The list is managed by the user: emptying it later is deliberate, not a fresh
		// start the global Git identity should be seeded into again
		seed.attempted = true;
		return;
	}
	const name = config.user.name.global, email = config.user.email.global;
	if (name === null || email === null) return;
	seed.attempted = true;
	saveCommitAuthors(ctx, [{ name: name, email: email }]);
}
