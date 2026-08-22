/**
 * One-off: builds the crab-augmented variants of the ORIGINAL mhutchie artwork
 * (downloaded to target/orig/) into resources/. Kept for reference; the outputs are committed.
 */
const fs = require('fs');

// The crab overlay in the original 24-grid, shared by every colour icon below.
const crab = `
    <!-- snip sparks where the branch was cut -->
    <g stroke="#d9008f" stroke-width="0.7" stroke-linecap="round">
      <path d="M 15.3 13.7 L 16.3 13.1"/>
      <path d="M 15.7 15.1 L 16.9 15.1"/>
      <path d="M 15.3 18.9 L 16.3 19.5"/>
    </g>

    <!-- the little crab, perched on the merge line, holding the severed ends of the branch apart -->
    <g stroke-linecap="round">
      <g stroke="#c9331f" stroke-width="0.9" fill="none">
        <path d="M 9.9 16.1 L 8.7 15.6"/>
        <path d="M 9.8 17.1 L 8.5 17.2"/>
        <path d="M 10.1 17.9 L 9.1 18.8"/>
      </g>
      <path d="M 13.3 15.9 C 13.1 15.4 12.9 15 12.8 14.7" stroke="#e03a26" stroke-width="1.1" fill="none"/>
      <path d="M 13.3 17.5 C 13.1 17.9 12.9 18.3 12.9 18.5" stroke="#e03a26" stroke-width="1.1" fill="none"/>
      <g fill="#f2543d">
        <path d="M 12.55 14.15 L 11.38 14.83 A 1.35 1.35 0 1 1 11.38 13.47 Z" transform="rotate(-30 12.55 14.15)"/>
        <path d="M 12.6 18.75 L 11.43 18.07 A 1.35 1.35 0 1 0 11.43 19.43 Z" transform="rotate(30 12.6 18.75)"/>
      </g>
      <g transform="rotate(-8 12 16.7)">
        <ellipse cx="12" cy="16.7" rx="2.35" ry="1.75" fill="#f2543d"/>
        <circle cx="11.35" cy="15.85" r="0.78" fill="#ffffff"/>
        <circle cx="11.6" cy="15.95" r="0.35" fill="#20140f"/>
        <path d="M 12.5 15.65 q 0.62 -0.5 1.24 0.04" fill="none" stroke="#7a1d0f" stroke-width="0.5"/>
        <path d="M 10.8 14.9 q 0.7 -0.55 1.5 -0.25" fill="none" stroke="#8e2113" stroke-width="0.45"/>
        <path d="M 11.3 17.5 q 0.85 0.85 1.7 -0.05" fill="none" stroke="#8e2113" stroke-width="0.5"/>
      </g>
    </g>
`;

// webview icons: the original artwork verbatim, with the crab appended before </svg>.
const webview = fs.readFileSync('target/orig/webview-icon.svg', 'utf8');
const withCrab = webview.replace('</svg>', crab + '</svg>');
fs.writeFileSync('resources/git-graph-rs-webview-icon.svg', withCrab);
fs.writeFileSync('resources/git-graph-rs-webview-icon-dark.svg', withCrab);
fs.writeFileSync('resources/git-graph-rs-webview-icon-light.svg', withCrab);
console.log('webview icons written');
