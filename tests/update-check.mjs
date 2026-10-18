// Update check test: runs the packaged server (build/app, from `npm run package`) on a spare port
// with its own data folder, against a fake GitHub releases API, and drives "Check now" in Chrome.
//
//   npm run package && node tests/update-check.mjs
//
// Leaves any real ipman install alone.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const app = path.join(root, 'build', 'app', 'server.mjs');
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5194;
const API_PORT = 5195;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(app)) throw new Error('build/app/server.mjs is missing: run npm run package first.');
const version = JSON.parse(readFileSync(path.join(root, 'build', 'app', 'version.json'), 'utf8')).version;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(ok ? `  PASS  ${what}` : `  FAIL  ${what}  ${detail}`);
  if (!ok) failed++;
};

// ---------- Fake GitHub ----------

const api = { hits: 0, tag: `v${version}`, fail: false };
const apiServer = http.createServer((req, res) => {
  api.hits++;
  if (api.fail) return (res.statusCode = 500), res.end();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ tag_name: api.tag, html_url: `https://example.invalid/releases/${api.tag}` }));
});
await new Promise((r) => apiServer.listen(API_PORT, '127.0.0.1', r));

// ---------- Packaged server ----------

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ipman-update-check-'));
const server = spawn(process.execPath, [app], {
  env: { ...process.env, PORT: String(PORT), IPMAN_DATA_DIR: dataDir, IPMAN_RELEASES_API: `http://127.0.0.1:${API_PORT}/latest` },
  stdio: 'ignore',
});
const version_ = (query = '') => fetch(`${BASE}/version${query}`).then((r) => r.json());
for (let i = 0; ; i++) {
  try {
    await version_();
    break;
  } catch {
    if (i > 50) throw new Error('the packaged server did not start');
    await sleep(200);
  }
}

let browser;
try {
  console.log(`update check, packaged ipman ${version}`);
  let v = await version_();
  check('without check: GitHub not asked', api.hits === 0 && v.packaged && v.latest === null, JSON.stringify(v));
  v = await version_('?check=1');
  check('check=1: asks GitHub, up to date', api.hits === 1 && v.latest === version && !v.updateAvailable && v.checkedAt > 0, JSON.stringify(v));
  api.tag = 'v99.0.0';
  v = await version_('?check=1');
  check('check=1 again within the hour: not asked again', api.hits === 1 && v.latest === version, `hits ${api.hits}`);
  v = await version_('?check=now');
  check('check=now within 30 s of the last ask: not asked again', api.hits === 1, `hits ${api.hits}`);
  await sleep(31000);
  v = await version_('?check=now');
  check('check=now: asks right away, update found', api.hits === 2 && v.latest === '99.0.0' && v.updateAvailable, JSON.stringify(v));
  await version_('?check=now');
  check('check=now twice within 30 s: asked once', api.hits === 2, `hits ${api.hits}`);

  // The "Check now" link. Within 30 s of the last ask, so the server answers from what it has.
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.setItem('ipman.checkUpdates', 'false'));
  await page.reload();
  await page.click('#settings-btn');
  check('Check now shown for an installed copy', await page.$eval('#check-now', (b) => !b.hidden && b.offsetParent !== null));
  check('update checks off: no notice yet', await page.$eval('#update-notice', (n) => n.hidden));
  await page.click('#check-now');
  await page.waitForFunction(() => document.getElementById('check-now').textContent === 'Check now', { timeout: 10000 });
  const title = await page.$eval('#update-notice', (n) => (n.hidden ? '' : n.querySelector('#update-title').textContent));
  check('Check now: shows the update', title === `ipman 99.0.0 is available (you have ${version}).`, title);

  await sleep(31000);
  api.fail = true;
  await page.click('#check-now');
  await page.waitForFunction(() => document.getElementById('check-result').textContent, { timeout: 10000 });
  const result = await page.$eval('#check-result', (e) => e.textContent);
  check('Check now with GitHub down: says why', result === 'Could not check: HTTP 500' && api.hits === 3, `${result} (hits ${api.hits})`);
} finally {
  await browser?.close();
  server.kill();
  apiServer.close();
  await sleep(300);
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
