/* Stylesheet imports of the on-demand modules (task 5.9): the webview build loads .css files
 * imported from the module graph as TEXT (the chunk injects them at runtime — see
 * src/webview/common/onDemandStyles.ts), so an import answers the stylesheet's content. The
 * critical stylesheet never enters the module graph; it keeps its own esbuild CSS entry. */
declare module '*.css' {
	const css: string;
	export default css;
}
