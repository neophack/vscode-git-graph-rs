/**
 * The ES2018 syntax gate (REFACTOR-PLAN §3.7.2): VS Code 1.38 runs the webview in Chromium 69,
 * whose JavaScript is ES2018. The webview sources are written against ES2018 and the emitted
 * bundle must stay within it, so both are scanned for every newer syntax form, with the
 * TypeScript parser (already a dev dependency) instead of a regex - template strings, comments
 * and regular expression literals cannot produce false positives.
 *
 * Built-in APIs newer than ES2018 (Array.prototype.flat, Object.fromEntries, ...) are caught by
 * the webview tsconfig's `lib: ["es2018", "dom"]`, not here.
 *
 *   node scripts/build/es2018.mjs <file.js|file.ts>...
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const LOGICAL_ASSIGNMENT_OR_NULLISH = new Map([
	[ts.SyntaxKind.QuestionQuestionToken, 'nullish coalescing (??, ES2020)'],
	[ts.SyntaxKind.QuestionQuestionEqualsToken, 'logical assignment (??=, ES2021)'],
	[ts.SyntaxKind.BarBarEqualsToken, 'logical assignment (||=, ES2021)'],
	[ts.SyntaxKind.AmpersandAmpersandEqualsToken, 'logical assignment (&&=, ES2021)']
]);

/**
 * Find the syntax newer than ES2018 in one source text.
 * @param text The source text.
 * @param fileName The file name (its extension selects TypeScript or JavaScript parsing).
 * @param classFieldsAllowed Whether class property declarations are accepted: TypeScript sources
 * declare their class members (the compiler lowers any initialiser into the constructor), while a
 * class field in emitted JavaScript is ES2022 syntax.
 * @returns One "line:column description" entry per violation.
 */
export function findPostEs2018Syntax(text, fileName, classFieldsAllowed) {
	const isTs = fileName.endsWith('.ts');
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, isTs ? ts.ScriptKind.TS : ts.ScriptKind.JS);
	const problems = [];
	const report = (node, description) => {
		const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
		problems.push((line + 1) + ':' + (character + 1) + ' ' + description);
	};

	const visit = (node) => {
		switch (node.kind) {
			case ts.SyntaxKind.PropertyAccessExpression:
			case ts.SyntaxKind.ElementAccessExpression:
			case ts.SyntaxKind.CallExpression:
				if (node.questionDotToken !== undefined) report(node, 'optional chaining (?., ES2020)');
				if (node.kind === ts.SyntaxKind.CallExpression && node.expression.kind === ts.SyntaxKind.ImportKeyword) report(node, 'dynamic import() (ES2020)');
				break;
			case ts.SyntaxKind.BinaryExpression: {
				const description = LOGICAL_ASSIGNMENT_OR_NULLISH.get(node.operatorToken.kind);
				if (description !== undefined) report(node.operatorToken, description);
				break;
			}
			case ts.SyntaxKind.PrivateIdentifier:
				report(node, 'private class member (#name, ES2022)');
				break;
			case ts.SyntaxKind.BigIntLiteral:
				report(node, 'BigInt literal (ES2020)');
				break;
			case ts.SyntaxKind.NumericLiteral:
				if (node.getText(source).includes('_')) report(node, 'numeric separator (ES2021)');
				break;
			case ts.SyntaxKind.RegularExpressionLiteral: {
				const flags = node.text.substring(node.text.lastIndexOf('/') + 1);
				if (/[dv]/.test(flags)) report(node, 'regular expression flag d/v (ES2022+)');
				break;
			}
			case ts.SyntaxKind.CatchClause:
				if (node.variableDeclaration === undefined) report(node, 'optional catch binding (ES2019)');
				break;
			case ts.SyntaxKind.ClassStaticBlockDeclaration:
				report(node, 'class static block (ES2022)');
				break;
			case ts.SyntaxKind.MetaProperty:
				if (node.keywordToken === ts.SyntaxKind.ImportKeyword) report(node, 'import.meta (ES2020)');
				break;
			case ts.SyntaxKind.PropertyDeclaration:
				if (!classFieldsAllowed) report(node, 'class field (ES2022)');
				break;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return problems;
}

/**
 * Check files against the ES2018 floor.
 * @param files The files to check.
 * @param root The directory the reported paths are relative to.
 * @returns One message per violation.
 */
export function checkFiles(files, root) {
	const problems = [];
	for (const file of files) {
		const relative = path.relative(root, file).split(path.sep).join('/');
		for (const problem of findPostEs2018Syntax(fs.readFileSync(file, 'utf8'), file, file.endsWith('.ts'))) {
			problems.push(relative + ':' + problem);
		}
	}
	return problems;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const problems = checkFiles(process.argv.slice(2).map((file) => path.resolve(file)), process.cwd());
	for (const problem of problems) console.error(problem);
	process.exit(problems.length > 0 ? 1 : 0);
}
