import { formatLongDate } from '../../common/dates';
import { generateSignatureHtml } from '../../common/gitNames';
import { html } from '../../common/html';
import { formatStr, markup } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { GraphContext } from '../context';
import { CLASS_EXTERNAL_URL, TextFormatter } from '../text/textFormatter';

/**
 * Show the details of an annotated tag (the object, the commit, the tagger and the message).
 */
export function showTagDetails(ctx: GraphContext, tagName: string, commitHash: string, details: GG.GitTagDetails) {
	const store = ctx.store;
	const textFormatter = new TextFormatter(store.commits, store.getIssueLinkingConfig(), {
		commits: true,
		emoji: true,
		issueLinking: true,
		markdown: store.config.markdown,
		multiline: true,
		urls: true
	});
	ctx.dialog.showMessage(html`${formatStr(markup.tagDetailsTitle, tagName)}<br><span class="messageContent">${markup.tagDetailsObject}${details.hash}<br>${markup.tagDetailsCommit}${commitHash}<br>${
		// A lightweight tag has no tagger of its own, so there is no tagger or date to show.
		details.taggerName !== '' || details.taggerEmail !== ''
			? html`${markup.tagDetailsTagger}${details.taggerName} &lt;<a class="${CLASS_EXTERNAL_URL}" href="mailto:${details.taggerEmail}" tabindex="-1">${details.taggerEmail}</a>&gt;${details.signature !== null ? generateSignatureHtml(details.signature) : ''}<br>${markup.tagDetailsDate}${formatLongDate(details.taggerDate, store.config.dateFormat)}<br>`
			: ''}<br>${textFormatter.format(details.message)}</span>`);
}
