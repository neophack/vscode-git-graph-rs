/* The minimal ambient declaration of the markdown-it package: markdown-it ships no
 * types of its own and @types/markdown-it is not a dependency, while the webview's typecheck
 * (`types: []`, noImplicitAny) needs the one import of src/webview/graph/text/markdown.ts typed.
 * Only the surface that module uses is declared - the constructor with the three options the
 * preconfigured instance passes, and parse(). The token shape the webview consumes is
 * markdown.ts's own MarkdownItToken (verified against markdown-it 12.3.2), which is why parse()
 * answers the loose `object[]` here and markdown.ts holds the one deliberate cast. */
declare module 'markdown-it' {
	interface MarkdownItConstructorOptions {
		html?: boolean;
		linkify?: boolean;
		breaks?: boolean;
	}
	class MarkdownIt {
		constructor(options?: MarkdownItConstructorOptions);
		parse(src: string, env: object): object[];
	}
	export default MarkdownIt;
}
