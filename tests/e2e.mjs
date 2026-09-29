// End-to-end tests: drive the real app in headless Chrome against a running ipman server.
//
//   node tests/e2e.mjs [--base http://127.0.0.1:5174] [--only name,name] [--heavy]
//
// Works against any ipman server (Vite dev server, Node or Go standalone server). Test media are
// generated with ffmpeg on first run and cached in the system temp folder. "Network" scenarios
// use public test streams (Apple, Mux) and need internet access. --heavy adds a slow 4K-bitrate
// buffering test. Each scenario uses a fresh browser profile, so your own ipman data is untouched.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:5174').replace(/\/$/, '');
const ONLY = arg('only', '')?.split(',').filter(Boolean) ?? [];
const HEAVY = args.includes('--heavy');
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FFMPEG = process.env.IPMAN_FFMPEG ?? 'ffmpeg';
const MEDIA_PORT = 5198;
const MEDIA = `http://127.0.0.1:${MEDIA_PORT}`;
const FIXTURES = path.join(os.tmpdir(), 'ipman-test-fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Test media ----------

function srt(lines, every, text) {
  const t = (s) => new Date(s * 1000).toISOString().slice(11, 19) + ',000';
  return Array.from({ length: lines }, (_, i) => `${i + 1}\n${t(i * every + 1)} --> ${t(i * every + 4)}\n${text(i + 1)}\n`).join('\n');
}

function fixture(name, ffmpegArgs, prepare) {
  const file = path.join(FIXTURES, name);
  if (existsSync(file)) return file;
  mkdirSync(FIXTURES, { recursive: true });
  prepare?.();
  console.log(`  generating ${name}…`);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...ffmpegArgs, file], { cwd: FIXTURES, stdio: 'inherit', timeout: 300_000 });
  return file;
}

// Test picture and tone. Both are endless: every fixture must pass an output duration (-t).
const testsrc = (size) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000'];
const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p'];

const media = {
  ac3Live: () => fixture('ac3-live.ts', [...testsrc('1280x720'), '-t', '60', ...x264, '-crf', '30', '-c:a', 'ac3', '-ac', '2', '-f', 'mpegts']),
  movieAac: () =>
    fixture('movie-aac.mkv', [...testsrc('1280x720'), '-i', 'no.srt', '-i', 'sv.srt', '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-t', '150', ...x264, '-crf', '30',
      '-c:a', 'aac', '-c:s:0', 'srt', '-c:s:1', 'ass', '-metadata:s:s:0', 'language=nor', '-metadata:s:s:1', 'language=swe', '-metadata:s:s:1', 'title=Svenska (ASS)'],
      () => {
        writeFileSync(path.join(FIXTURES, 'no.srt'), srt(30, 5, (n) => `Norsk linje ${n}${n % 7 === 1 ? '\n<i>kursiv</i>' : ''}`));
        writeFileSync(path.join(FIXTURES, 'sv.srt'), srt(30, 5, (n) => `Svensk rad ${n}`));
      }),
  movieEac3: () =>
    fixture('movie-eac3.mkv', [...testsrc('1280x720'), '-i', 'no.srt', '-map', '0', '-map', '1', '-map', '2', '-t', '150', ...x264, '-crf', '30',
      '-c:a', 'eac3', '-ac', '6', '-c:s', 'srt', '-metadata:s:s:0', 'language=nor'],
      () => writeFileSync(path.join(FIXTURES, 'no.srt'), srt(30, 5, (n) => `Norsk linje ${n}`))),
  heavyEac3: () => fixture('heavy-eac3.mkv', [...testsrc('1920x1080'), '-t', '100', '-vf', 'noise=alls=30:allf=t', ...x264, '-b:v', '40M', '-maxrate', '40M', '-bufsize', '80M', '-c:a', 'eac3', '-ac', '6']),
};

// ---------- Media server (range requests, like an IPTV provider) ----------

const playlists = new Map();
const files = new Map();
const guideXml = (() => {
  const now = Date.now();
  const fmt = (ms) => { const d = new Date(ms + 2 * 3600e3); const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0200`; };
  return `<?xml version="1.0" encoding="UTF-8"?>
<tv>
 <channel id="TV2.no"><display-name>TV 2 Direkte</display-name></channel>
 <programme start="${fmt(now - 30 * 60e3)}" stop="${fmt(now + 30 * 60e3)}" channel="TV2.no"><title lang="no">Nyhetene</title><title lang="en">The News</title><desc>Siste nytt &amp; sport</desc></programme>
 <programme start="${fmt(now + 30 * 60e3)}" stop="${fmt(now + 90 * 60e3)}" channel="TV2.no"><title>Farmen & venner</title></programme>
 <programme start="${fmt(now - 5 * 3600e3)}" stop="${fmt(now - 4 * 3600e3)}" channel="TV2.no"><title>Too old</title></programme>
 <programme start="${fmt(now + 100 * 60e3)}" channel="TV2.no"><title>Debatten</title></programme>
</tv>`;
})();

const mediaServer = http.createServer((req, res) => {
  const url = new URL(req.url, MEDIA);
  if (url.pathname === '/guide.xml') return res.end(guideXml);
  if (url.pathname === '/guide.xml.gz') return res.end(gzipSync(guideXml));
  if (playlists.has(url.pathname)) return res.end(playlists.get(url.pathname));
  const file = files.get(url.pathname);
  if (!file) return (res.statusCode = 404), res.end();
  const size = statSync(file).size;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : size - 1;
  res.writeHead(m ? 206 : 200, {
    'content-type': file.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp2t',
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
    ...(m && { 'content-range': `bytes ${start}-${end}/${size}` }),
  });
  createReadStream(file, { start, end }).pipe(res).on('error', () => {});
});

/** Serves a one-or-more-channel playlist; returns its URL. */
function playlist(name, channels) {
  const lines = ['#EXTM3U'];
  for (const [i, ch] of channels.entries()) {
    let url = ch.url;
    if (ch.file) {
      const p = ch.path ?? `/media/${name}-${i}${path.extname(ch.file)}`;
      files.set(p, ch.file);
      url = MEDIA + p;
    }
    lines.push(`#EXTINF:-1 group-title="${ch.group}",${ch.name}`, url);
  }
  playlists.set(`/${name}.m3u`, lines.join('\n'));
  return `${MEDIA}/${name}.m3u`;
}

// ---------- Browser helpers ----------

let browser;

async function openApp(playlistUrl) {
  const context = await browser.createBrowserContext(); // fresh profile: empty localStorage
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/`);
  await page.evaluate((url) => localStorage.setItem('ipman.settings', JSON.stringify({ playlistUrl: url, useProxy: true, epgUrl: '' })), playlistUrl);
  await page.reload();
  await page.waitForSelector('.channel');
  page.close = ((close) => async () => { await close.call(page); await context.close(); })(page.close);
  return page;
}

const video = (page, fn, ...a) => page.evaluate(fn, ...a);
const state = (page) =>
  page.evaluate(() => {
    const v = document.getElementById('video');
    const $ = (id) => document.getElementById(id);
    const showing = [...v.textTracks].find((t) => t.mode === 'showing');
    return {
      status: $('np-status').textContent,
      time: $('ctl-time').hidden ? null : $('ctl-time').textContent,
      live: !$('ctl-live').hidden,
      audioBytes: v.webkitAudioDecodedByteCount,
      currentTime: v.currentTime,
      cue: showing ? [...(showing.activeCues ?? [])].map((c) => c.text).join(' / ') : null,
    };
  });

async function waitFor(page, fn, timeout = 30000, ...a) {
  return page.waitForFunction(fn, { timeout, polling: 200 }, ...a).then(() => true, () => false);
}

async function chooseSubtitle(page, label) {
  await page.mouse.move(700, 300);
  await page.click('#subtitle-btn');
  const items = await page.$$eval('#subtitle-menu .menu-item', (xs) => xs.map((x) => x.textContent));
  const i = items.findIndex((t) => t.includes(label));
  if (i < 0) throw new Error(`subtitle "${label}" not in menu: ${items.join(' | ')}`);
  await (await page.$$('#subtitle-menu .menu-item'))[i].click();
  return items;
}

/** Waits until the showing track has an active cue, and returns [position label, cue text]. */
async function nextCue(page, timeout = 15000) {
  const ok = await waitFor(page, () => [...document.getElementById('video').textTracks].some((t) => t.mode === 'showing' && t.activeCues?.length), timeout);
  const s = await state(page);
  return ok ? [s.time, s.cue] : [s.time, null];
}

function seekTo(page, seconds, duration) {
  return page.evaluate((v) => {
    const s = document.getElementById('seek');
    s.value = String(Math.round(v * 1000));
    s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new Event('change'));
  }, seconds / duration);
}

const cueWindow = (text, every = 5) => {
  const n = Number(/linje (\d+)|rad (\d+)/.exec(text ?? '')?.slice(1).find(Boolean));
  return n ? [(n - 1) * every + 1, (n - 1) * every + 4] : null;
};
/** Whether a cue is the right one for a position. The time label only has whole seconds: tolerance 1.1. */
const inWindow = (seconds, text, tolerance = 0.6) => {
  const w = cueWindow(text);
  return !!w && seconds >= w[0] - tolerance && seconds <= w[1] + tolerance;
};
const parseTime = (label) => label?.split(' / ')[0].split(':').reduce((acc, x) => acc * 60 + Number(x), 0);

// ---------- Scenarios ----------

const scenarios = {
  async api(check) {
    const get = (p) => fetch(BASE + p).then(async (r) => ({ status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() }));
    check('page served', (await get('/')).status === 200);
    check('non-http proxy target refused', (await get('/proxy?url=file%3A%2F%2F%2Fetc%2Fpasswd')).status === 400);
    const mvod = JSON.parse((await get('/vod-info?url=http%3A%2F%2Fnone%2Fx.mkv')).body);
    check('vod-info shape', Array.isArray(mvod.tracks) && Array.isArray(mvod.cues) && mvod.transcodeStart === null);
    for (const f of ['guide.xml', 'guide.xml.gz']) {
      const g = JSON.parse((await get(`/epg?url=${encodeURIComponent(`${MEDIA}/${f}`)}&force=1`)).body);
      const list = g.programmes['tv2.no'] ?? [];
      check(`${f}: programmes in window, old one dropped`, list.length === 3 && !list.some((p) => p.title === 'Too old'), list.map((p) => p.title).join(', '));
      check(`${f}: first title kept, entities decoded`, list[0]?.title === 'Nyhetene' && list[0]?.desc === 'Siste nytt & sport');
      check(`${f}: missing stop filled (+1 h)`, list[2] && list[2].stop - list[2].start === 3600e3);
      check(`${f}: name index`, g.names.tv2direkte === 'tv2.no');
    }
  },

  async ui(check) {
    const url = playlist('ui', [
      { name: 'S1', group: 'Sweden - Sport', url: 'http://127.0.0.1:1/a' },
      { name: 'N1', group: 'Norway - Sport', url: 'http://127.0.0.1:1/b' },
      { name: 'N2', group: 'Norway - Nyheter', url: 'http://127.0.0.1:1/c' },
      { name: 'Å', group: 'Åland - X', url: 'http://127.0.0.1:1/d' },
      { name: 'B', group: 'Bosna i Hercegovina', url: 'http://127.0.0.1:1/e' },
    ]);
    const page = await openApp(url);
    const countries = await page.$$eval('#country-select option', (o) => o.map((x) => x.textContent));
    check('countries sorted', countries.slice(2).join(',') === 'Åland,Bosna i Hercegovina,Norway,Sweden', countries.join(', '));
    await page.select('#country-select', 'Norway');
    await page.select('#category-select', 'Sport');
    await page.reload();
    await page.waitForSelector('.channel');
    const kept = await page.evaluate(() => [document.getElementById('country-select').value, document.getElementById('category-select').value]);
    check('filter remembered after reload', kept.join('/') === 'Norway/Sport', kept.join('/'));
    await page.click('#collapse-btn');
    await page.reload();
    await page.waitForSelector('.channel');
    check('collapsed sidebar remembered', await page.evaluate(() => document.getElementById('app').classList.contains('sidebar-collapsed')));
    check('no page errors', !page.errors.length, page.errors.join('; '));
    await page.close();
  },

  async hlsSubtitles(check) {
    const url = playlist('hls', [{ name: 'Apple bipbop', group: 'Test - HLS', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' }]);
    const page = await openApp(url);
    await page.click('.channel');
    check('subtitle button appears', await waitFor(page, () => !document.getElementById('subtitle-btn').hidden));
    await sleep(2000);
    check('subtitles off by default', await video(page, () => ![...document.getElementById('video').textTracks].some((t) => t.mode === 'showing')));
    const items = await chooseSubtitle(page, 'English');
    check('menu lists subtitles and CC', items.includes('English') && items.some((t) => t.includes('(CC)')), items.join(' | '));
    const [, cue] = await nextCue(page);
    check('English subtitle shows', !!cue, cue);
    await page.keyboard.press('Space');
    check('Space pauses', await waitFor(page, () => document.getElementById('video').paused, 3000));
    await page.close();
  },

  async ac3Live(check) {
    const url = playlist('ac3', [{ name: 'AC-3 channel', group: 'Test - AC3', file: media.ac3Live() }]);
    const page = await openApp(url);
    const requests = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    await page.click('.channel');
    check('plays with sound via ffmpeg', await waitFor(page, () => document.getElementById('video').webkitAudioDecodedByteCount > 0, 60000));
    check('switched to /transcode', requests.includes('/transcode'), [...new Set(requests)].join(' → '));
    check('LIVE badge, no seek bar', (await state(page)).live);
    await page.reload();
    await page.waitForSelector('.channel');
    requests.length = 0;
    await page.click('.channel');
    await waitFor(page, () => document.getElementById('video').webkitAudioDecodedByteCount > 0, 60000);
    check('second start goes straight to /transcode', !requests.includes('/proxy') && requests.includes('/transcode'), [...new Set(requests)].join(' → '));
    await page.close();
  },

  async mkvSubtitles(check) {
    const url = playlist('mkv', [{ name: 'NC - Test Movie (2025)', group: 'Movies: Nordic [Multi-Sub]', file: media.movieAac(), path: '/movie/u/p/1.mkv' }]);
    const page = await openApp(url);
    await page.click('.channel');
    check('movie mode: seek bar and time', await waitFor(page, () => !document.getElementById('seek-row').hidden && /\/ 2:30$/.test(document.getElementById('ctl-time').textContent)));
    check('status says Playing', await waitFor(page, () => document.getElementById('np-status').textContent.includes('Playing')));
    check('subtitle button appears', await waitFor(page, () => !document.getElementById('subtitle-btn').hidden, 20000));
    const items = await chooseSubtitle(page, 'Norwegian');
    check('menu lists SRT and ASS tracks', items.some((t) => t.includes('Svenska (ASS)')), items.join(' | '));
    const [label, cue] = await nextCue(page);
    check('cue in sync', inWindow(await video(page, () => document.getElementById('video').currentTime), cue), `${label} ${cue}`);
    await seekTo(page, 100, 150);
    await waitFor(page, () => document.getElementById('video').currentTime > 99);
    await sleep(1500);
    const [label2, cue2] = await nextCue(page);
    const t2 = await video(page, () => document.getElementById('video').currentTime);
    check('cue in sync after seek', t2 > 99 && inWindow(t2, cue2), `${label2} ${cue2}`);
    await page.keyboard.press('ArrowRight');
    await sleep(500);
    check('→ skips 10 s', (await video(page, () => document.getElementById('video').currentTime)) > t2 + 8);
    check('no page errors', !page.errors.length, page.errors.join('; '));
    await page.close();
  },

  async eac3Movie(check) {
    const url = playlist('eac3', [{ name: '4K-NC:Test Movie - 2025', group: 'Movies: Nordic 4K', file: media.movieEac3(), path: '/movie/u/p/2.mkv' }]);
    const page = await openApp(url);
    const requests = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    await page.click('.channel');
    check('switches to ffmpeg, plays with sound', await waitFor(page, () => document.getElementById('video').webkitAudioDecodedByteCount > 0, 60000));
    check('went through /transcode', requests.includes('/transcode'), [...new Set(requests)].join(' → '));
    check('seek bar with full duration', await waitFor(page, () => /\/ 2:30$/.test(document.getElementById('ctl-time').textContent), 15000));
    await chooseSubtitle(page, 'Norwegian');
    const [label, cue] = await nextCue(page, 20000);
    check('cue in sync (converted)', inWindow(parseTime(label), cue, 1.1), `${label} ${cue}`);
    await seekTo(page, 100, 150);
    check('plays again after seek', await waitFor(page, () => !document.getElementById('video').paused && document.getElementById('np-status').textContent.includes('Playing'), 45000));
    await sleep(1500);
    const [label2, cue2] = await nextCue(page, 20000);
    check('cue in sync after seek (converted)', parseTime(label2) >= 99 && inWindow(parseTime(label2), cue2, 1.1), `${label2} ${cue2}`);
    await page.reload();
    await page.waitForSelector('.channel');
    requests.length = 0;
    await page.click('.channel');
    await waitFor(page, () => document.getElementById('video').webkitAudioDecodedByteCount > 0, 60000);
    check('second start goes straight to /transcode', !requests.includes('/proxy') || requests.indexOf('/transcode') < requests.indexOf('/proxy'), [...new Set(requests)].join(' → '));
    await page.close();
  },

  async heavyMovie(check) {
    const url = playlist('heavy', [{ name: '4K-NC:Heavy - 2025', group: 'Movies: Nordic 4K', file: media.heavyEac3(), path: '/movie/u/p/3.mkv' }]);
    const page = await openApp(url);
    await page.click('.channel');
    await waitFor(page, () => document.getElementById('video').webkitAudioDecodedByteCount > 0, 60000);
    let minAhead = Infinity;
    for (let i = 0; i < 8; i++) {
      await sleep(10_000);
      const ahead = await video(page, () => { const v = document.getElementById('video'); const b = v.buffered; return b.length ? b.end(b.length - 1) - v.currentTime : 0; });
      minAhead = Math.min(minAhead, ahead);
    }
    const s = await state(page);
    check('40 Mbit/s movie plays 80 s without running dry', minAhead > 2 && parseTime(s.time) > 75, `min buffer ahead ${minAhead.toFixed(1)} s at ${s.time}`);
    await page.close();
  },
};

// ---------- Runner ----------

const selected = Object.keys(scenarios).filter((name) => (ONLY.length ? ONLY.includes(name) : name !== 'heavyMovie' || HEAVY));
console.log(`ipman e2e against ${BASE}: ${selected.join(', ')}`);
await new Promise((r) => mediaServer.listen(MEDIA_PORT, '127.0.0.1', r));
browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1280, height: 720 } });

let failed = 0;
for (const name of selected) {
  console.log(`\n${name}`);
  const check = (what, ok, detail) => {
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? `  (${detail})` : ''}`);
  };
  try {
    await scenarios[name](check);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${err.message}`);
  }
}
await browser.close();
mediaServer.close();
console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
