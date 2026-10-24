/**
 * The configuration theme: the config values the view consumes, the raw entries of one
 * location, and a single remote's fetch URL.
 */

import { GitConfigSnapshot } from '../../../../backend/types';
import { EOL, GitCli } from './process';
import { getRemotes } from './refs';

/**
 * The configuration values the view consumes, read with a single `git config -l -z`.
 *
 * The `-z` output is `key\nvalue\0` per entry, which cannot be confused by embedded newlines in
 * values. Later entries win, matching how Git resolves repeated keys.
 */
export async function getConfig(cli: GitCli, repo: string): Promise<GitConfigSnapshot> {
	const [configOut, remotes] = await Promise.all([cli.run(['config', '-l', '-z'], repo), getRemotes(cli, repo)]);
	const values = new Map<string, string>();
	for (const entry of configOut.replace(/\u0000$/, '').split('\u0000')) {
		const separator = entry.indexOf('\n');
		if (separator === -1) continue;
		values.set(entry.slice(0, separator), entry.slice(separator + 1));
	}
	const get = (key: string): string | null => values.get(key) ?? null;

	const remoteConfigs = remotes.map((name) => ({
		name,
		url: get(`remote.${name}.url`),
		pushUrl: get(`remote.${name}.pushurl`)
	}));
	return {
		remotes: remoteConfigs,
		userName: get('user.name'),
		userEmail: get('user.email'),
		pushDefault: get('remote.pushdefault'),
		diffTool: get('diff.tool'),
		diffGuiTool: get('diff.guitool')
	};
}

/** The config entries of one location, last value per key. */
export async function getConfigList(cli: GitCli, repo: string, location: 'local' | 'global'): Promise<{ [key: string]: string }> {
	const out = await cli.run(
		['--no-pager', 'config', '--list', '-z', '--includes', `--${location}`],
		repo
	).catch((error) => {
		const message = String(error instanceof Error ? error.message : error).toLowerCase();
		if (message.startsWith('fatal: unable to read config file') && message.endsWith('no such file or directory')) {
			return '';
		}
		throw error;
	});
	const configs: { [key: string]: string } = {};
	const pairs = out.split('\0');
	for (let i = 0; i < pairs.length - 1; i++) {
		const lines = pairs[i].split(EOL);
		const key = lines.shift()!;
		configs[key] = lines.join('\n');
	}
	return configs;
}

/** The fetch URL of a remote, or NULL when it is not configured. */
export async function getRemoteUrl(cli: GitCli, repo: string, remote: string): Promise<string | null> {
	try {
		const out = await cli.run(['config', '--get', `remote.${remote}.url`], repo);
		return out.split(EOL)[0];
	} catch {
		// `git config --get` exits non-zero when the key is unset: that is the answer, not a failure.
		return null;
	}
}
