/**
 * The entry point of the standalone Binary Compare tab: a slim header naming the file and the two
 * revisions (rendered by the extension host), and the shared binary comparison area filling the
 * rest. The boot `init` message tells the page which of its two views to enter; every further
 * message is routed to it by the area.
 */

import { BinaryCompareBridge } from './host';
import { BinaryCompareArea } from './binaryCompareArea';
import type { BinaryCompareInitResponse } from '../../shared/protocol/binaryCompare';
import { setCompareStringsLanguage } from './strings';

const diffArea = document.getElementById('diffArea');
if (diffArea !== null) {
	const bridge = new BinaryCompareBridge();
	const area = new BinaryCompareArea({
		root: diffArea,
		send: (message) => bridge.send(message)
	});
	area.installGlobalInput();

	bridge.onMessage((msg) => {
		if (msg.command === 'init') {
			const init = <BinaryCompareInitResponse>msg;
			setCompareStringsLanguage(init.language);
			area.setFileIsImage(init.isImage);
			if (init.isImage) area.enterImage(0);
			else area.enterHex(0);
			return;
		}
		area.handle(msg);
	});

	// The page's script has loaded and is listening: ask for the boot data (the host answers with
	// the init message, and holds the request until its own data is ready).
	bridge.send({ command: 'ready' });
}
