/* Real-browser (Edge, real layout engine) reproduction of the mid-history vertical jump. */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
	executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
	headless: 'new', args: ['--window-size=1280,760']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
await page.goto('http://127.0.0.1:8932/tests/browserRepro/index.html', { waitUntil: 'load' });
await page.waitForSelector('#commitTable tr.commit');
await new Promise((r) => setTimeout(r, 500));

const readResult = () => page.$eval('#result', (el) => el.textContent);

await page.click('#btnJump');
await new Promise((r) => setTimeout(r, 500));
console.log('JUMP:', await readResult());

await page.click('#btnRewrite');
await new Promise((r) => setTimeout(r, 800));
console.log('REWRITE:', await readResult());

// fresh reload for the prepend (fetch) scenario
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#commitTable tr.commit');
await new Promise((r) => setTimeout(r, 500));
await page.click('#btnJump');
await new Promise((r) => setTimeout(r, 500));
await page.click('#btnFetch');
await new Promise((r) => setTimeout(r, 800));
console.log('FETCH:', await readResult());

await browser.close();
