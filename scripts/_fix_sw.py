import re
p='web/settingsWidget.ts'
s=open(p,encoding='utf8').read()

# 1. remove Gerrit settings section from html
i=s.index("			const gerritConfig = this.view.getGerritConfig();")
j=s.index("			html += '<div class=\"settingsSection centered\"><h3>Issue Linking</h3>';")
s=s[:i]+s[j:]

# 2. remove Gerrit listeners block (showGerritBar + editGerritFetchConfig)
i=s.index("			const showGerritBarElem = <HTMLInputElement | null>document.getElementById('settingsShowGerritBarCheckbox');")
j=s.index("			document.getElementById('editIssueLinking')!.addEventListener('click', () => {")
s=s[:i]+s[j:]

# 3. remove showGerritFetchConfigDialog method
i=s.index("	/**\n	 * Show the dialog allowing the user to configure the Gerrit change refs cache")
j=s.index("	/**\n	 * Show the dialog allowing the user to configure the issue linking for this repository.")
s=s[:i]+s[j:]

# 4. catch (e) unknown
s=s.replace("""			} catch (e) {
				regExpParseError = e.message;
			}""","""			} catch (e) {
				regExpParseError = e instanceof Error ? e.message : String(e);
			}""")

open(p,'w',encoding='utf8').write(s)
print('remaining gerrit:', len(re.findall(r'[Gg]errit',s)))
for m in re.finditer(r'.*[Gg]errit.*',s): print(m.group(0)[:120])
