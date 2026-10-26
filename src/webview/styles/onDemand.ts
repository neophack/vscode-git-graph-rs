/**
 * The on-demand stylesheet chunk of task 5.9's CSS split: the styles of the widget surfaces
 * whose MODULES sit in the first-paint bundle (the action runners reach them synchronously)
 * but whose DOM only appears after a user action - the dialogs (with their custom selects),
 * the context menu, the commit details view with its file tree, and the Gerrit review dialog.
 *
 * This module is reached ONLY through dynamic import() (native on the Chromium 69 floor), so
 * esbuild emits it as an on-demand chunk carrying every sheet below as TEXT (the build's .css
 * loader); the moment the chunk evaluates, the sheets are injected into the page (the CSP
 * allows inline styles). The entry prefetches the chunk while the user is idle after the first
 * paint, and every path that first shows one of these surfaces kicks the same import (see
 * ensureWidgetStyles in src/webview/common/onDemandStyles.ts), so the styles are in place by
 * the time the user can see the widget - the first paint never fetches them.
 */

import { injectOnDemandStyles } from '../common/onDemandStyles';
import commitDetailsCss from './commitDetails.css';
import contextMenuCss from './contextMenu.css';
import dialogCss from './dialog.css';
import fileTreeCss from './fileTree.css';
import gerritReviewCss from './gerritReview.css';
import tabletCommitDetailsCss from './tablet/commitDetails.css';
import tabletOverlaysCss from './tablet/overlays.css';

/* Each sheet below carries its own phone-layout section (the former styles/mobile/ sheets were
 * merged into their component files, OPTIMIZATION-PLAN §6 F6); the tablet sheets still load
 * separately and are injected after the component sheets so their touch refinements win. */
injectOnDemandStyles(dialogCss);
injectOnDemandStyles(contextMenuCss);
injectOnDemandStyles(tabletOverlaysCss);
injectOnDemandStyles(commitDetailsCss);
injectOnDemandStyles(tabletCommitDetailsCss);
injectOnDemandStyles(fileTreeCss);
injectOnDemandStyles(gerritReviewCss);
