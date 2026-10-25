/* The comparison pages of the theme audit: the Commit Comparison View (media/comparison.min.css,
 * which inlines the shared binary-compare area styles) and the standalone Binary Compare tab in
 * both its hex and image modes (media/binaryCompare.min.css). */

import { icons, imgUri } from './icons.mjs';

const section = (title, body) =>
	`<h2 class="sectionTitle">${title}</h2>\n${body}`;

/** The Commit Comparison View: header cards, divider, sidebar tree and a syntax-highlighted diff. */
const comparisonBody = `
<div id="header">
	<div id="commitCards" class="expanded">
		<div class="commitCard hasMessage" data-role="base">
			<div class="firstLine"><span class="chip">BASE</span><span class="author">neophack</span><span class="subject">fix: use theme variables…</span><span class="date">Oct 9</span><span class="toggle">▶</span></div>
			<div class="message">Uses the theme variables for every signature icon state, so high-contrast themes keep their outlines.</div>
		</div>
		<div class="compareDivider">
			<span class="arrow">→</span>
			<span class="count">12 files</span>
			<span class="arrow">←</span>
		</div>
		<div class="commitCard hasMessage" data-role="compare">
			<div class="firstLine"><span class="chip">COMPARE</span><span class="author">neophack</span><span class="subject">feat: support themed…</span><span class="date">Oct 10</span><span class="toggle">▶</span></div>
			<div class="message">Adds the themed status colours across the commit table and the details view.</div>
		</div>
	</div>
</div>
<div id="body">
	<div id="sidebar">
		<h2>12 FILES <span class="additions">+242</span> <span class="deletions">-99</span></h2>
		<div class="treeRow"><span class="arrow">▾</span><span class="name">src</span></div>
		<div class="treeRow selected"><span class="arrow">▸</span><span class="name">webview</span></div>
		<div class="treeRow" style="padding-left:24px"><span class="arrow"></span><span class="name">main.ts</span><span class="counts"><span class="additions">+32</span> <span class="deletions">-4</span></span></div>
		<div class="treeRow" style="padding-left:24px"><span class="arrow"></span><span class="name">styles.css</span><span class="counts pending">+… -…</span></div>
	</div>
	<div id="sidebarResizer"></div>
	<div id="main">
		<div id="fileHeader">
			<span id="filePath">src/webview/main.ts</span>
			<button type="button">Swap Sides</button>
			<button type="button">Open Changes</button>
		</div>
		<div id="diffArea">
			<table class="diff"><tbody>
				<tr class="hunk"><td colspan="3">@@ -12,7 +12,9 @@ function render()</td></tr>
				<tr class="ctx"><td class="ln old">12</td><td class="ln new">12</td><td class="old code">const theme = getTheme();</td></tr>
				<tr class="del"><td class="ln old">13</td><td class="ln new"></td><td class="old code">const <mark>colours = FIXED_PALETTE</mark>;</td></tr>
				<tr class="add"><td class="ln old"></td><td class="ln new">13</td><td class="new code">const <mark>colours = themeVariables()</mark>;</td></tr>
				<tr class="mod"><td class="ln old">14</td><td class="ln new">14</td><td class="old code">apply(<mark>colours</mark>, root);</td></tr>
				<tr class="mod"><td class="ln old"></td><td class="ln new">15</td><td class="new code">apply(<mark>colours, { fallbacks: true }</mark>, root);</td></tr>
				<tr class="ctx"><td class="ln old">15</td><td class="ln new">16</td><td class="new code"><span class="hljs-keyword">return</span> <span class="hljs-title function_">render</span>(<span class="hljs-params">root</span>);</td></tr>
				<tr class="ctx"><td class="ln old">16</td><td class="ln new">17</td><td class="new code"><span class="hljs-comment">// trailing comment</span></td></tr>
			</tbody></table>
		</div>
	</div>
</div>
`;

const comparisonCss = `
body{display:block;height:auto;overflow:visible}
#header{position:relative}
#body{position:relative}
#diffArea{overflow:visible}
`;

/** The standalone Binary Compare tab: hex view with differing bytes, context menu, image view. */
const binaryCompareBody = `
${section('Binary compare — hex mode (differing and selected bytes)', `
<div id="diffArea" class="hexMode" style="position:relative;display:flex;overflow:visible">
	<div id="hexWrap">
		<div id="hexToolbar">
			<b>logo.png</b>
			<span class="hxSpacer"></span>
			<button type="button">Copy selection</button>
			<button type="button" disabled>Undo</button>
			<span class="hxCopyStatus">Copied 4 bytes</span>
		</div>
		<div id="hexScroller" style="overflow:visible">
			<div id="hexInner">
				<div id="hexHead">
					<div id="hexCaps">
						<div class="hcap"><span>OLD (rev1)</span><span class="hxSize">312 bytes</span></div>
						<div class="hcap"><span>NEW (rev2)</span><span class="hxSize">318 bytes</span></div>
					</div>
					<div id="hexRuler"><div class="hrow"><span class="hside" style="grid-template-columns:10ch repeat(4, 3ch) 1ch repeat(4, 3ch) 1ch 1.5ch 1ch repeat(5, 2ch);"><span class="hoff">0</span><span class="hb">0</span><span class="hb">1</span><span class="hb">2</span><span class="hb">3</span><span class="hbg"></span><span class="hb">4</span><span class="hb">5</span><span class="hb">6</span><span class="hb">7</span><span class="hg"></span><span class="ha">a</span><span class="ha">b</span><span class="ha">c</span><span class="ha">d</span><span class="ha">e</span></span></div></div>
					<div id="hexSpacer"><div id="hexView">
						<div class="hrow"><span class="hside" style="grid-template-columns:10ch repeat(4, 3ch) 1ch repeat(4, 3ch) 1ch 1.5ch 1ch repeat(5, 2ch);"><span class="hoff">0000</span><span class="hb">89</span><span class="hb">50</span><span class="hb">4e</span><span class="hb">47</span><span class="hbg"></span><span class="hb">0d</span><span class="hb">0a</span><span class="hb">1a</span><span class="hb">0a</span><span class="hg"></span><span class="ha">.</span><span class="ha">P</span><span class="ha">N</span><span class="ha">G</span><span class="ha">.</span></span></div>
						<div class="hrow hxOdd"><span class="hside" style="grid-template-columns:10ch repeat(4, 3ch) 1ch repeat(4, 3ch) 1ch 1.5ch 1ch repeat(5, 2ch);"><span class="hoff">0010</span><span class="hb hxo">00</span><span class="hb">00</span><span class="hb">00</span><span class="hb">0d</span><span class="hbg"></span><span class="hb hxn">00</span><span class="hb">00</span><span class="hb">00</span><span class="hb hxn">1a</span><span class="hg"></span><span class="ha hxo">.</span><span class="ha">.</span><span class="ha">.</span><span class="ha hxn">.</span><span class="ha">.</span></span></div>
						<div class="hrow"><span class="hside" style="grid-template-columns:10ch repeat(4, 3ch) 1ch repeat(4, 3ch) 1ch 1.5ch 1ch repeat(5, 2ch);"><span class="hoff">0020</span><span class="hb hxSel">49</span><span class="hb">48</span><span class="hb">44</span><span class="hb hxSel">52</span><span class="hbg"></span><span class="hb">00</span><span class="hb">00</span><span class="hb">00</span><span class="hb">60</span><span class="hg"></span><span class="ha">I</span><span class="ha">H</span><span class="ha">D</span><span class="ha">R</span><span class="ha">.</span></span></div>
					</div></div>
				</div>
			</div>
		</div>
	</div>
</div>
<div id="hexMenu" style="position:relative;display:block;margin:12px 0">
	<div class="hexMenuItem">Copy byte offset</div>
	<div class="hexMenuItem">Copy selection (hex)</div>
	<div class="hexMenuItem disabled">Copy selection (bytes)</div>
	<div class="hexMenuSep"></div>
	<div class="hexMenuItem">Switch to image mode</div>
</div>`)}

${section('Binary compare — image mode (old / diff / new)', `
<div id="diffArea2" class="imgMode" style="position:relative;display:flex;overflow:visible">
	<div id="imgWrap">
		<div id="imgToolbar">
			<b>mascot.webp</b>
			<span class="hxSpacer"></span>
			<span id="imgStats">identical: 98.2% of pixels</span>
			<div id="imgControls">
				<label><input type="checkbox" checked>Diff</label>
				<label>Zoom <input type="range" min="1" max="8" value="2"></label>
				<label>Side <select><option>Column</option></select></label>
			</div>
		</div>
		<div id="imgScroller" style="overflow:visible">
			<div id="imgRow">
				<div class="imgPane"><div class="imgCaption">OLD (rev1)</div><div class="imgHolder"><img src="${imgUri('#4a5568')}" width="96" height="64" alt="old"></div></div>
				<div class="imgPane"><div class="imgCaption">DIFF</div><div class="imgHolder"><img src="${imgUri('#21262d')}" width="96" height="64" alt="diff"></div></div>
				<div class="imgPane"><div class="imgCaption">NEW (rev2)</div><div class="imgHolder"><img src="${imgUri('#2d5a88')}" width="96" height="64" alt="new"></div></div>
			</div>
		</div>
	</div>
</div>
<div class="status">Text files are compared line by line; this tab shows the binary comparison.</div>`)}
`;

const binaryCompareCss = `
body.binaryComparePage{display:block;height:auto;overflow:visible}
#hexScroller, #hexHead{position:relative;border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.35))}
#hexHead{position:relative}
#hexMenu{animation:none}
`;

/** The comparison pages of the audit. */
export const comparePages = [
	{ name: 'comparison', label: 'Commit comparison view', stylesheet: 'comparison', bodyClass: '', viewport: { width: 1280, height: 900 }, body: comparisonBody, harnessCss: comparisonCss },
	{ name: 'binary-compare', label: 'Binary compare (hex and image modes)', stylesheet: 'binaryCompare', bodyClass: 'binaryComparePage', viewport: { width: 1280, height: 900 }, body: binaryCompareBody, harnessCss: binaryCompareCss }
];
