import { AutomationAction } from './catalog';
import { ContextProbes } from './runContext';

/**
 * The post-run repository-state verification: when a write action declares `verify` (the exact
 * branch/tag/remote/HEAD state its designed outcome must leave behind), these checks judge the
 * LIVE repository after the run — through the same hard probes the run context resolves from, so
 * a verify never reads the rendered page's cache.
 */

/**
 * Check the post-run repository state against the action's verify declaration. Returns NULL when
 * the declared outcome holds, or the failure message.
 */
export async function verifyAction(probes: ContextProbes, action: AutomationAction, context: Record<string, string>): Promise<string | null> {
	const verify = action.verify!;
	// A `{{name}}` reference resolves from the run context; anything else is the plain literal
	// the action itself names (the exact branch/tag/remote a catalogued write creates).
	let expected: string | undefined;
	if (verify.placeholder.startsWith('{{') && verify.placeholder.endsWith('}}')) {
		const name = verify.placeholder.slice(2, -2);
		if (!(name in context)) return 'verify placeholder "' + name + '" was not resolved';
		expected = context[name];
	} else {
		expected = verify.placeholder;
	}
	if (expected === undefined || expected === '') return 'verify target "' + verify.placeholder + '" did not resolve to a name';
	const repoInfo = await probes.queryRepoInfo(context.repo);
	switch (verify.kind) {
		case 'headIs':
			return repoInfo.head === expected ? null : 'expected HEAD to be "' + expected + '", got "' + repoInfo.head + '"';
		case 'headIsNot':
			return repoInfo.head !== expected ? null : 'expected HEAD to differ from "' + expected + '"';
		case 'headSubjectStartsWith': {
			// The newest commit of the live graph — what a just-created commit (fixup!, squash!)
			// must be. A literal prefix, never a placeholder: the catalog names it.
			const newest = (await probes.queryCommits(context.repo, 1))[0];
			const subject = newest === undefined ? '' : newest.message.split('\n')[0];
			return subject.indexOf(expected) === 0 ? null : 'expected the newest commit\'s subject to start with "' + expected + '", got "' + subject + '"';
		}
		case 'branchPresent':
			return (repoInfo.branches ?? []).includes(expected) ? null : 'expected branch "' + expected + '" to exist';
		case 'branchAbsent':
			return !(repoInfo.branches ?? []).includes(expected) ? null : 'expected branch "' + expected + '" to be gone';
		case 'tagPresent':
			return (await liveTagNames(probes.queryCommits, context.repo)).includes(expected) ? null : 'expected tag "' + expected + '" to exist';
		case 'tagAbsent':
			return !(await liveTagNames(probes.queryCommits, context.repo)).includes(expected) ? null : 'expected tag "' + expected + '" to be gone';
		case 'remotePresent':
			return (repoInfo.remotes ?? []).includes(expected) ? null : 'expected remote "' + expected + '" to exist';
		case 'remoteAbsent':
			return !(repoInfo.remotes ?? []).includes(expected) ? null : 'expected remote "' + expected + '" to be gone';
	}
}

/**
 * The tag names of the live graph (loadRepoInfo carries none). Hard-probed like every context
 * read — a tag a write action just created must be seen regardless of what the rendered page
 * has cached. Page-deep: every catalogued tag target sits inside the first 300 commits.
 */
export async function liveTagNames(queryCommits: ContextProbes['queryCommits'], repo: string): Promise<string[]> {
	const commits = await queryCommits(repo, 300);
	const names: string[] = [];
	for (const commit of commits) {
		for (const tag of commit.tags ?? []) names.push(tag.name);
	}
	return names;
}
