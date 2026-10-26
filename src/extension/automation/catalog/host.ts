/**
 * The host actions of the automation catalog (task 6.2 split): carved verbatim out of
 * the former single-file catalog.ts, each action now carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { DISMISS_ERROR_DIALOG_STEP } from './helpers';

export const HOST_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Host-only requests ---------- */
	{
		id: 'host/copy-to-clipboard',
		title: 'Copy Commit Hash to Clipboard',
		group: 'host',
		tags: ['host'],
		mutable: false,
		request: [{ command: 'copyToClipboard', type: 'Commit Hash', data: '{{commit}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'host/open-extension-settings',
		title: 'Open Extension Settings',
		group: 'host',
		tags: ['host'],
		mutable: false,
		request: [{ command: 'openExtensionSettings' }],
		expect: { responses: ['openExtensionSettings'] }
	},
	{
		id: 'host/open-file',
		title: 'Open File',
		group: 'host',
		tags: ['host'],
		mutable: false,
		requires: ['file'],
		// Opens the context commit's file, as the Commit Details View's "Open File" does. The
		// file need not exist in the working tree at HEAD (the fixture checks it out only on
		// local-ahead — see cdv/file-open-file), so the refusal is the designed outcome, not a
		// failure: without allowErrorOn this would false-fail the read suite on any repository
		// whose context file is absent from the working tree.
		request: [{ command: 'openFile', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['openFile'] },
		allowErrorOn: ['openFile']
	},
	{
		id: 'host/open-log-file',
		title: 'Open Log File',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The Settings Widget's "Open Log File" tool. With session logging disabled (the fixture)
		// the host answers with an error dialog; with it enabled (a developer machine) the log
		// simply opens and no dialog appears — so the settle step tolerates both instead of a
		// hard .dialog wait, and a leaked modal can never swallow the later runs' shortcuts.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openLogFile' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'openLogFile' }],
		expect: { responses: ['openLogFile'] },
		// With session logging disabled the host's error IS the designed answer (see the comment
		// above); with logging enabled the same command succeeds. Both outcomes pass; anything
		// else the pipeline reports still fails.
		allowErrorOn: ['openLogFile']
	},
	{
		id: 'host/open-terminal',
		title: 'Open a Terminal for this Repository',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// `name` is display-only; the live view passes the repository's display name.
		request: [{ command: 'openTerminal', repo: '{{repo}}', name: '{{repo}}' }],
		expect: { responses: ['openTerminal'] }
	},
	{
		id: 'host/view-scm',
		title: 'Open Source Control View',
		group: 'host',
		tags: ['host'],
		mutable: false,
		request: [{ command: 'viewScm' }],
		expect: { responses: ['viewScm'] }
	}
];
