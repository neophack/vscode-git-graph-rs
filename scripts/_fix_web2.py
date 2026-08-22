def rw(p, pairs):
    s=open(p,encoding='utf8').read()
    for old,new in pairs:
        assert old in s, (p, old[:60])
        s=s.replace(old,new)
    open(p,'w',encoding='utf8').write(s)

def cut(p, start, end):
    s=open(p,encoding='utf8').read()
    i=s.index(start); j=s.index(end, i+len(start))
    s=s[:i]+s[j:]
    open(p,'w',encoding='utf8').write(s)

# contextMenuActions.ts: remove the Gerrit context-menu section (double-spaced file)
cut('web/contextMenuActions.ts',
    "\t], [\n\n\t\t{\n\n\t\t\ttitle: strings.menuViewGerritReviewInfo,",
    "\t], [\n\n\t\t{\n\n\t\t\ttitle: view.isCommitPinned(hash) ? 'Unpin Commit' : 'Pin Commit',")
cut('web/contextMenuActions.ts',
    "\n\nfunction getGerritAutosquashMenuItem(view: GitGraphView, mode: 'fixup' | 'squash', hash: string, target: DialogTarget & CommitTarget): ContextMenuAction {",
    "\n\nfunction getRemoteBranchContextMenuActions(view: GitGraphView, remote: string, target: DialogTarget & RefTarget): ContextMenuActions {")

# observers.ts
s=open('web/observers.ts',encoding='utf8').read()
old1="""		if ((eventElem = eventTarget.closest('.gg-meta-chip')) !== null) {
			// Gerrit meta chip was clicked: toggle the expanded state of the change's meta event rows
			e.stopPropagation();
			if (contextMenu.isOpen()) contextMenu.close();
			const change = parseInt(eventElem.dataset.change!);
			toggleGerritChangeExpanded(view, change);
			// Meta rows are rendered purely in the webview: re-render the table (and the graph lanes, which must stretch over the meta rows)
			view.render();

		} else if ((eventElem = eventTarget.closest('.gitRef')) !== null) {"""
new1="""		if ((eventElem = eventTarget.closest('.gitRef')) !== null) {"""
assert old1 in s
s=s.replace(old1,new1)
old2="""			if (eventElem.classList.contains('gerrit')) {
				// Gerrit change badge was clicked: show the review information
				showGerritReviewInfo(view, unescapeHtml(eventElem.dataset.hash!));
			}
"""
assert old2 in s
s=s.replace(old2,"")
i=s.index("			if (eventElem.classList.contains('gerrit')) {\n				// Gerrit change badge was right clicked")
j=s.index("			} else if (eventElem.classList.contains(CLASS_REF_STASH)) {")
s=s[:i]+s[j:]
open('web/observers.ts','w',encoding='utf8').write(s)

# settingsWidget.ts
s=open('web/settingsWidget.ts',encoding='utf8').read()
i=s.index("			const gerritConfig = this.view.getGerritConfig();")
j=s.index("			html += '<div class=\"settingsSection centered\"><h3>Issue Linking</h3>';")
s=s[:i]+s[j:]
i=s.index("			const showGerritBarElem = <HTMLInputElement | null>document.getElementById('settingsShowGerritBarCheckbox');")
j=s.index("	/**\n	 * Show the dialog allowing the user to configure the Gerrit change refs cache")
s=s[:i]+s[j:]
i=s.index("	/**\n	 * Show the dialog allowing the user to configure the Gerrit change refs cache")
j=s.index("	/**\n	 * Show the dialog allowing the user to configure the issue linking for this repository.")
s=s[:i]+s[j:]
s=s.replace("""			} catch (e) {
				regExpParseError = e.message;
			}""","""			} catch (e) {
				regExpParseError = e instanceof Error ? e.message : String(e);
			}""")
open('web/settingsWidget.ts','w',encoding='utf8').write(s)

rw('web/findWidget.ts', [
    ("this.widgetElem.setAttribute(ATTR_ERROR, e.message);",
     "this.widgetElem.setAttribute(ATTR_ERROR, e instanceof Error ? e.message : String(e));"),
])

p='web/tsconfig.json'
s=open(p,encoding='utf8').read()
s=s.replace('"target": "es5"','"target": "es2015"')
open(p,'w',encoding='utf8').write(s)
print('done')
