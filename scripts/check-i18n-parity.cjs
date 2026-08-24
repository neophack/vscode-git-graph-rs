/* Checks EN/ZH dictionary key + placeholder parity for the webview and extension host strings. */
const fs = require('fs');

function extractDict(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start);
	const block = source.slice(start, end);
	const dict = {};
	const re = /\n\t([a-zA-Z0-9]+): '((?:[^'\\]|\\.)*)'/g;
	let m;
	while ((m = re.exec(block)) !== null) dict[m[1]] = m[2];
	return dict;
}

function check(name, en, zh) {
	const enKeys = Object.keys(en), zhKeys = Object.keys(zh);
	let problems = 0;
	for (const k of enKeys) if (!zhKeys.includes(k)) { console.log(name, 'MISSING ZH key:', k); problems++; }
	for (const k of zhKeys) if (!enKeys.includes(k)) { console.log(name, 'MISSING EN key:', k); problems++; }
	const ph = (s) => [...new Set((s.match(/\{\d+\}/g) || []).sort())].join(',');
	for (const k of enKeys) {
		if (!zh[k]) continue;
		if (ph(en[k]) !== ph(zh[k])) { console.log(name, 'PLACEHOLDER MISMATCH', k, 'EN:[' + ph(en[k]) + '] ZH:[' + ph(zh[k]) + ']'); problems++; }
	}
	console.log(name + ': ' + enKeys.length + ' EN keys, ' + zhKeys.length + ' ZH keys, ' + problems + ' problems');
	return problems;
}

let problems = 0;
const web = fs.readFileSync('web/strings.ts', 'utf8');
problems += check('web', extractDict(web, 'const STRINGS_EN = {', 'type WebviewStrings'), extractDict(web, 'const STRINGS_ZH_CN', 'The currently active string dictionary'));

const i18n = fs.readFileSync('src/i18n.ts', 'utf8');
problems += check('src', extractDict(i18n, 'const EN = {', 'type MessageKey'), extractDict(i18n, 'const ZH_CN', 'Is the interface language'));

process.exit(problems > 0 ? 1 : 0);
