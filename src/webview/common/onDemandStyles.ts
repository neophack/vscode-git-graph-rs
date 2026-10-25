/**
 * Style injection for the on-demand chunks of the first-paint split (REFACTOR-PLAN task 5.9).
 *
 * The styles of a lazily imported widget travel INSIDE its chunk as text (the webview build
 * gives .css imports the 'text' loader): esbuild emits a chunk's CSS as a sibling file but does
 * NOT load it when the chunk is dynamically imported, and the webview cannot know the hashed
 * sibling's URL - so each on-demand module injects its stylesheet from the bundled string the
 * moment the module evaluates. The page CSP allows inline styles ('unsafe-inline' in style-src),
 * so a <style> element needs no exemption. Deduplicated by content: a module evaluated twice
 * (a re-import after a failure, or several modules sharing one stylesheet) injects it once.
 */

const injected = new Set<string>();

/** Inject one on-demand stylesheet (a no-op outside a DOM, e.g. in node-environment tests). */
export function injectOnDemandStyles(css: string): void {
	if (typeof document === 'undefined' || injected.has(css)) return;
	injected.add(css);
	const style = document.createElement('style');
	style.textContent = css;
	document.head.appendChild(style);
}
