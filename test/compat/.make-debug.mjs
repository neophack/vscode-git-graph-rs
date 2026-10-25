// Temporary debug injector: wraps the smoke with a TypeError stack trap and verbose logging.
// Not part of the compat suite; deleted after use.
import fs from 'node:fs';

let src = fs.readFileSync('test/compat/runtime-smoke.cjs', 'utf8');
src = src.replace(
	'get(key, defaultValue) { return defaultValue; }',
	'get(key, defaultValue) { return key === "enableLog" ? true : defaultValue; }'
);
const inject = [
	'const RealTypeError = TypeError;',
	'global.TypeError = function TypeError(message) {',
	'  const e = new RealTypeError(message);',
	'  console.error("CAPTURED STACK:\\n" + e.stack);',
	'  return e;',
	'};'
].join('\n');
src = src.replace('/* ---------- the vscode module stub', inject + '\n\n/* ---------- the vscode module stub');
fs.writeFileSync('test/compat/.debug-smoke.cjs', src);
console.error('debug copy written');
