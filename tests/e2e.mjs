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
  // A fake Xtream panel: get.php serves a playlist, player_api.php the account.
  if (url.pathname === '/get.php') return res.end(playlists.get('/xtream.m3u') ?? '#EXTM3U\n');
  if (url.pathname === '/player_api.php') {
    const ok = url.searchParams.get('username') === 'testuser' && url.searchParams.get('password') === 'testpass';
    res.setHeader('content-type', 'application/json');
    const action = url.searchParams.get('action');
    if (ok && action === 'get_vod_streams') {
      return res.end(JSON.stringify([
        { stream_id: 224555, rating: '7.447', added: '1760780040' },
        { stream_id: 130303, rating: '6.2', added: '1700000000' },
        { stream_id: 247855, rating: '0', added: '2147483647' },
      ]));
    }
    if (ok && action === 'get_series_categories') {
      return res.end(JSON.stringify([{ category_id: '10', category_name: 'Series: Spanish' }, { category_id: '11', category_name: 'Series: Swedish' }]));
    }
    if (ok && action === 'get_series') {
      return res.end(JSON.stringify([
        { name: 'Breaking Bad (ES)', series_id: 501, cover: 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg', rating: '8.9', releaseDate: '2008-01-20', category_id: '10' },
        { name: 'SE:Trespasses (2025)', series_id: 502, cover: '', rating: '0', releaseDate: '2025-11-09', category_id: '11' },
      ]));
    }
    if (ok && action === 'get_series_info') {
      const ep = (id, s, e, title, plot) => ({ id: String(id), episode_num: e, season: s, title: `Breaking Bad (ES) - S0${s}E0${e} - ${title}`, container_extension: 'mkv', info: { duration_secs: 150, plot, air_date: '2008-01-20' } });
      return res.end(JSON.stringify(url.searchParams.get('series_id') === '501'
        ? {
            info: {
              name: 'Breaking Bad (ES)', plot: 'A chemistry teacher diagnosed with cancer turns to making meth.', genre: 'Drama, Crime', cast: 'Bryan Cranston, Aaron Paul',
              director: 'Vince Gilligan', releaseDate: '2008-01-20', rating: '8.9', backdrop_path: ['https://image.tmdb.org/t/p/w1280/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg'], tmdb: '1396', youtube_trailer: 'HhesaQXLuRY',
            },
            episodes: {
              1: [ep(9001, 1, 1, 'Pilot', 'Walter White starts cooking.'), ep(9002, 1, 2, "Cat's in the Bag...", 'Walt and Jesse clean up.'), ep(9003, 1, 3, "...And the Bag's in the River", '')],
              2: [ep(9004, 2, 1, 'Seven Thirty-Seven', '')],
            },
          }
        : { info: {}, episodes: [] }));
    }
    if (ok && action === 'get_vod_info') {
      return res.end(JSON.stringify(url.searchParams.get('vod_id') === '224555'
        ? {
            info: {
              name: 'Superman', o_name: 'Superman', plot: 'Superman, a journalist in Metropolis, embarks on a journey to reconcile his Kryptonian heritage.',
              genre: 'Science Fiction, Adventure, Action', releasedate: '2025-07-09', duration_secs: '7760', rating: '7.447',
              director: 'James Gunn', cast: 'David Corenswet, Rachel Brosnahan, Nicholas Hoult', youtube_trailer: 'Z9Z6Jv1xQT8', tmdb_id: '1061474',
              cover_big: 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/wPLysNDLffQLOVebZQCbXJEv6E6.jpg',
              backdrop_path: ['https://image.tmdb.org/t/p/w1280/eGX66zonvc4bXg3rM08RUxdYSDx.jpg'], bitrate: 20523,
            },
            movie_data: { container_extension: 'mkv' },
          }
        : { info: {}, movie_data: {} }));
    }
    return res.end(JSON.stringify({
      user_info: ok
        ? { auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 3 * 86400 + 3600), is_trial: '0', active_cons: '0', max_connections: '1' }
        : { auth: 0 },
    }));
  }
  if (playlists.has(url.pathname)) return res.end(playlists.get(url.pathname));
  // Like a provider whose file is gone: it answers 400.
  if (url.pathname.startsWith('/refused/')) return (res.statusCode = 400), res.end('Bad Request');
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

async function openApp(playlistUrl, section = 'live') {
  const context = await browser.createBrowserContext(); // fresh profile: empty localStorage
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/`);
  await page.evaluate((url, sec) => {
    localStorage.setItem('ipman.settings', JSON.stringify({ playlistUrl: url, useProxy: true, epgUrl: '' }));
    localStorage.setItem('ipman.section', JSON.stringify(sec));
  }, playlistUrl, section);
  await page.reload();
  await page.waitForSelector(ready[section]);
  page.close = ((close) => async () => { await close.call(page); await context.close(); })(page.close);
  return page;
}

/** What each section shows once the playlist is in. */
const ready = { live: '.channel', movie: '#movie-grid .movie-card', series: '#series-grid .movie-card' };

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

/**
 * Clicks a card. The grid redraws its cards when ratings arrive, which can replace the element
 * between finding and clicking it: then click the new one.
 */
async function clickCard(page, selector, index = 0) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await (await page.$$(selector))[index].click();
    } catch (err) {
      if (attempt >= 5 || !/detached|not clickable/i.test(err.message)) throw err;
      await sleep(200);
    }
  }
}

/** MOVIES: open the first card and press "Play Movie". */
async function playMovie(page) {
  await page.waitForSelector('.movie-card');
  await clickCard(page, '.movie-card');
  await page.waitForSelector('#md-play', { visible: true });
  await page.click('#md-play');
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
    const raw = (p, headers) => new Promise((resolve) => {
      const u = new URL(BASE + p);
      http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0));
    });
    const guideUrl = `/epg?url=${encodeURIComponent(`${MEDIA}/guide.xml`)}`;
    check('another host name (DNS rebinding) refused', (await raw(guideUrl, { host: 'evil.example:5174' })) === 403);
    check('requests from other sites refused', (await raw(guideUrl, { 'sec-fetch-site': 'cross-site' })) === 403);
    check('own page and tools allowed', (await raw(guideUrl, { 'sec-fetch-site': 'same-origin' })) === 200 && (await raw(guideUrl, {})) === 200);
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

  async sections(check) {
    const url = playlist('sections', [
      { name: 'NO: TV 2', group: 'Norway - Sport', url: 'http://127.0.0.1:1/live/u/p/1.ts' },
      { name: 'SE: SVT1', group: 'Sweden - Nyheter', url: 'http://127.0.0.1:1/u/p/2' },
      { name: 'Movie A', group: 'Movies: Nordic 4K', url: 'http://127.0.0.1:1/movie/u/p/3.mkv' },
      { name: 'Movie B', group: 'Movies: Nordic [Multi-Sub]', url: 'http://127.0.0.1:1/movie/u/p/4.mp4' },
      { name: 'Show S01 E01', group: 'Series: Nordic', url: 'http://127.0.0.1:1/series/u/p/5.mkv' },
    ]);
    const page = await openApp(url);
    const snapshot = () =>
      page.evaluate(() => ({
        pressed: [...document.querySelectorAll('.section-btn')].filter((b) => b.ariaPressed === 'true').map((b) => b.textContent),
        count: document.getElementById('channel-count').textContent,
        names: [...document.querySelectorAll('.channel-name')].map((n) => n.textContent),
        options: [...document.getElementById('country-select').options].slice(2).map((o) => o.textContent),
        placeholder: document.getElementById('search').placeholder,
      }));
    let s = await snapshot();
    check('TV is the default section', s.pressed.join() === 'TV');
    check('TV lists only live channels', s.names.join() === 'NO: TV 2,SE: SVT1', s.names.join());
    check('TV dropdown has no movie or series groups', s.options.join() === 'Norway,Sweden', s.options.join());
    await page.select('#country-select', 'Norway');
    await page.click('.section-btn[data-section="movie"]');
    s = await snapshot();
    check('MOVIES highlighted', s.pressed.join() === 'MOVIES');
    await page.waitForSelector('.movie-card');
    const movieCards = await page.$$eval('.movie-card .movie-title', (ts) => ts.map((t) => t.textContent));
    check('MOVIES shows only movies, as cards', movieCards.join() === 'Movie A,Movie B' && s.count === '2 movies', `${movieCards.join()} | ${s.count}`);
    const movieCategories = await page.$$eval('#movie-categories .category-name', (ns) => ns.slice(3).map((n) => n.textContent));
    check('movie categories without the "Movies:" prefix', movieCategories.join() === 'Nordic [Multi-Sub],Nordic 4K', movieCategories.join());
    check('search placeholder follows the section', s.placeholder.startsWith('Search movies'));
    await page.click('.section-btn[data-section="series"]');
    s = await snapshot();
    await page.waitForSelector('#series-grid .movie-card');
    const seriesCards = await page.$$eval('#series-grid .movie-title', (ts) => ts.map((t) => t.textContent));
    check('SERIES shows only series, as cards', seriesCards.join() === 'Show' && s.count === '1 series', `${seriesCards.join()} | ${s.count}`);
    await page.reload();
    await page.waitForSelector(ready.series);
    check('section remembered after reload', (await snapshot()).pressed.join() === 'SERIES');
    await page.click('.section-btn[data-section="live"]');
    s = await snapshot();
    check('TV keeps its own filter', s.names.join() === 'NO: TV 2', s.names.join());
    check('no page errors', !page.errors.length, page.errors.join('; '));
    await page.close();
  },

  async xtreamSettings(check) {
    playlist('xtream', [{ name: 'NO: TV 2', group: 'Norway - Sport', url: `${MEDIA}/live/testuser/testpass/1.ts` }]);
    const page = await openApp(`${MEDIA}/get.php?username=testuser&password=testpass&type=m3u_plus`);
    const status = () => page.$eval('#xtream-status', (s) => ({ text: s.textContent, tone: s.dataset.tone }));
    const waitStatus = () => waitFor(page, () => /✓|✗/.test(document.getElementById('xtream-status').textContent), 15000);
    await page.click('#settings-btn');
    const detected = await page.$eval('#xtream-detected', (p) => p.textContent);
    check('account detected from the playlist URL', detected.includes(`${MEDIA}, user testuser`), detected);
    check('fields stay empty, detected values as placeholders', await page.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      return $('xtream-server').value === '' && $('xtream-username').placeholder === 'testuser' && $('xtream-password').placeholder === 'from playlist';
    }));
    await waitStatus();
    let s = await status();
    check('connection tested automatically on open', s.text.startsWith('✓ Connected'), s.text);
    check('shows subscription, expiry and connections', /subscription active · expires .+\(in 3 days\) · 0 of 1 connection in use/.test(s.text), s.text);
    check('expiry within a week is highlighted', s.tone === 'warn', s.tone);
    await page.type('#xtream-password', 'wrong');
    await page.click('#xtream-test');
    await waitStatus();
    s = await status();
    check('wrong password reported', s.text === '✗ Wrong username or password.' && s.tone === 'error', s.text);
    await page.$eval('#xtream-password', (i) => (i.value = ''));
    await page.type('#xtream-server', '127.0.0.1:9');
    await page.click('#xtream-test');
    await waitStatus();
    s = await status();
    check('unreachable server reported', s.text.startsWith('✗') && s.tone === 'error', s.text);
    await page.click('#xtream-show');
    check('Show reveals the password field', await page.$eval('#xtream-password', (i) => i.type === 'text'));
    check('no page errors', !page.errors.length, page.errors.join('; '));
    await page.close();
  },

  async moviesView(check) {
    const tmdb = (file) => `https://image.tmdb.org/t/p/w600_and_h900_bestv2/${file}`;
    const movieFile = media.movieAac();
    files.set('/movie/testuser/testpass/224555.mkv', movieFile);
    playlists.set('/xtream.m3u', [
      '#EXTM3U',
      `#EXTINF:-1 tvg-logo="${tmdb('wPLysNDLffQLOVebZQCbXJEv6E6.jpg')}" group-title="Movies: Nordic 4K",4K-NC:Superman - 2025`,
      `${MEDIA}/movie/testuser/testpass/224555.mkv`,
      `#EXTINF:-1 tvg-logo="${tmdb('w82uniRRmszl7YpZyjdBEwTXlxI.jpg')}" group-title="Movies: Français",Habemus Papam (2011)`,
      `${MEDIA}/movie/testuser/testpass/130303.mp4`,
      `#EXTINF:-1 tvg-logo="${tmdb('3KPtpop8tDAVGs7Fu1NFi4DHavN.jpg')}" group-title="Movies: Finland",FI:Risto Räppääjä ja väärä Vincent - 2020`,
      `${MEDIA}/movie/testuser/testpass/247855.mkv`,
      `#EXTINF:-1 group-title="Norway - Sport",NO: TV 2`,
      `${MEDIA}/live/testuser/testpass/1.ts`,
    ].join('\n'));
    const page = await openApp(`${MEDIA}/get.php?username=testuser&password=testpass&type=m3u_plus`, 'movie');
    const cards = () => page.$$eval('.movie-card', (cs) => cs.map((c) => ({
      title: c.querySelector('.movie-title').textContent, meta: c.querySelector('.movie-meta').textContent, tag: c.querySelector('.poster-tag')?.textContent ?? '',
    })));
    await page.waitForSelector('.movie-card');
    await waitFor(page, () => document.querySelector('.movie-rating'), 15000);
    const all = await cards();
    check('grid shows the three movies, no TV channel', all.length === 3, JSON.stringify(all));
    const superman = all.find((c) => c.title === 'Superman');
    check('card: clean title, tag, rating, year and category', superman?.tag === '4K-NC' && superman.meta === '★ 7.42025Nordic 4K', JSON.stringify(superman));
    check('card without a rating shows year and category', all.find((c) => c.title.startsWith('Risto'))?.meta === '2020Finland');
    const categories = await page.$$eval('#movie-categories .category', (bs) => bs.map((b) => b.querySelector('.category-name').textContent + ' ' + b.querySelector('.category-count').textContent));
    check('categories with counts, prefix removed', categories.join(' | ') === 'All movies 3 | ▶ Continue watching 0 | ★ Favorites 0 | Finland 1 | Français 1 | Nordic 4K 1', categories.join(' | '));
    check('channel list and dropdowns hidden', await page.evaluate(() => getComputedStyle(document.getElementById('channel-list')).display === 'none' && getComputedStyle(document.querySelector('.filter-row')).display === 'none'));
    const order = async () => (await cards()).map((c) => c.title.split(' ')[0]).join(',');
    check('sorted by title by default', (await order()) === 'Habemus,Risto,Superman', await order());
    await page.select('#movie-sort', 'year');
    check('sort by year: newest first', (await order()) === 'Superman,Risto,Habemus', await order());
    await page.select('#movie-sort', 'rating');
    check('sort by rating: highest first, unrated last', (await order()) === 'Superman,Habemus,Risto', await order());
    await page.reload();
    await page.waitForSelector('.movie-card');
    await waitFor(page, () => document.querySelector('.movie-rating'), 15000);
    check('sort choice remembered', (await page.$eval('#movie-sort', (s) => s.value)) === 'rating' && (await order()) === 'Superman,Habemus,Risto', await order());
    await page.select('#movie-sort', 'title');
    await page.click('#movie-categories [data-category="Movies: Français"]');
    check('category filters the grid', (await cards()).map((c) => c.title).join() === 'Habemus Papam');
    check('no category on cards inside a category', (await cards())[0].meta === '★ 6.22011', (await cards())[0].meta);
    check('heading follows the category', (await page.$eval('#movie-heading', (h) => h.textContent)) === 'Français');
    await page.click('#movie-categories [data-category="__all__"]');
    await page.type('#search', 'super');
    check('search filters the grid', (await cards()).map((c) => c.title).join() === 'Superman');
    await page.click('.movie-card');
    await waitFor(page, () => document.getElementById('md-plot').textContent.length > 0, 15000);
    const details = await page.evaluate(() => ({
      title: document.getElementById('md-title').textContent, facts: document.getElementById('md-facts').textContent,
      meta: document.getElementById('md-meta').textContent, trailer: !document.getElementById('md-trailer').hidden, backdrop: !document.getElementById('md-backdrop').hidden,
    }));
    check('details: title and year', details.title === 'Superman (2025)', details.title);
    check('details: rating, runtime, genre', details.facts.includes('★ 7.4') && details.facts.includes('2 h 9 min') && details.facts.includes('Science Fiction'), details.facts);
    check('details: director, cast, file', details.meta.includes('James Gunn') && details.meta.includes('David Corenswet') && details.meta.includes('mkv · 20.5 Mbit/s'), details.meta);
    check('details: trailer link and backdrop', details.trailer && details.backdrop);
    await page.click('#md-fav');
    check('favorite from the dialog', (await page.$eval('#md-fav', (b) => b.textContent)) === '★ Favorite');
    await page.click('#md-play');
    check('Play Movie shows the player', await waitFor(page, () => document.getElementById('app').classList.contains('movie-playing') && !document.getElementById('video').paused, 30000));
    check('"← Movies" button visible while playing', await page.$eval('#back-btn', (b) => getComputedStyle(b).display !== 'none' && b.textContent === '← Movies'));
    await page.click('#back-btn');
    check('back to the grid, playback stopped', await page.evaluate(() => !document.getElementById('app').classList.contains('movie-playing') && document.getElementById('video').paused));
    check('favorite star on the card', await page.$eval('.movie-card', (c) => !!c.querySelector('.poster-fav')));

    // Resume: watch half, leave, come back.
    await clickCard(page, '.movie-card');
    await page.waitForSelector('#md-play', { visible: true });
    check('not started: "Play Movie", no "Play from start"', (await page.$eval('#md-play', (b) => b.textContent)) === '▶ Play Movie' && (await page.$eval('#md-restart', (b) => b.hidden)));
    await page.click('#md-play');
    await waitFor(page, () => !document.getElementById('video').paused, 30000);
    await seekTo(page, 75, 150);
    await waitFor(page, () => document.getElementById('video').currentTime > 76, 15000);
    await page.click('#back-btn');
    check('a started movie has a blue bar on its card', await page.$eval('.movie-card', (c) => parseFloat(c.querySelector('.watch-bar > span')?.style.width ?? '0') > 45));
    check('and is in "Continue watching"', (await page.$eval('#movie-categories [data-category="__continue__"] .category-count', (c) => c.textContent)) === '1');
    await clickCard(page, '.movie-card');
    await page.waitForSelector('#md-play', { visible: true });
    const resumeText = await page.$eval('#md-play', (b) => b.textContent);
    check('"Resume" with the position, and "Play from start"', /^▶ Resume \(1:1\d\)$/.test(resumeText) && !(await page.$eval('#md-restart', (b) => b.hidden)), resumeText);
    await page.click('#md-play');
    check('Resume continues where it was left', await waitFor(page, () => { const v = document.getElementById('video'); return !v.paused && v.currentTime > 65 && v.currentTime < 90; }, 30000));
    await page.click('#back-btn');
    await clickCard(page, '.movie-card');
    await page.waitForSelector('#md-restart', { visible: true });
    await page.click('#md-restart');
    check('"Play from start" starts at 0', await waitFor(page, () => { const v = document.getElementById('video'); return !v.paused && v.currentTime < 10; }, 30000));
    check('no page errors', !page.errors.length, page.errors.join('; '));
    await page.close();
  },

  async sectionMemory(check) {
    // Watch a movie, pause it, switch to TV and watch a channel, close; come back the next day.
    const movieFile = media.movieAac();
    files.set('/movie/testuser/testpass/224555.mkv', movieFile);
    files.set('/series/testuser/testpass/9001.mkv', movieFile);
    playlists.set('/xtream.m3u', [
      '#EXTM3U',
      '#EXTINF:-1 group-title="Movies: Nordic 4K",4K-NC:Superman - 2025', `${MEDIA}/movie/testuser/testpass/224555.mkv`,
      '#EXTINF:-1 group-title="Series: Spanish",Breaking Bad (ES) S01 E01', `${MEDIA}/series/testuser/testpass/9001.mkv`,
      '#EXTINF:-1 group-title="Norway - Sport",NO: TV 2', `${MEDIA}/testuser/testpass/1`,
      '#EXTINF:-1 group-title="Norway - Sport",NO: TV 3', `${MEDIA}/testuser/testpass/2`,
    ].join('\n'));
    const page = await openApp(`${MEDIA}/get.php?username=testuser&password=testpass&type=m3u_plus`, 'series');
    const playing = () => page.evaluate(() => ({ name: document.getElementById('np-name').textContent, t: document.getElementById('video').currentTime, paused: document.getElementById('video').paused }));
    // An episode, then a movie, each paused half-way.
    await clickCard(page, '#series-grid .movie-card');
    await page.waitForSelector('#sd-play', { visible: true });
    await page.click('#sd-play');
    await waitFor(page, () => !document.getElementById('video').paused, 30000);
    await seekTo(page, 60, 150);
    await waitFor(page, () => document.getElementById('video').currentTime > 61, 15000);
    await page.click('.section-btn[data-section="movie"]');
    check('switching section stops the episode', (await playing()).paused);
    await clickCard(page, '#movie-grid .movie-card');
    await page.waitForSelector('#md-play', { visible: true });
    await page.click('#md-play');
    await waitFor(page, () => !document.getElementById('video').paused, 30000);
    await seekTo(page, 90, 150);
    await waitFor(page, () => document.getElementById('video').currentTime > 91, 15000);
    await page.keyboard.press('Space');
    await page.click('.section-btn[data-section="live"]');
    check('TV stops the movie (nothing to resume there yet)', (await playing()).name === 'No channel selected');
    await page.click('.channel:nth-child(2)');
    await waitFor(page, () => document.getElementById('np-name').textContent === 'NO: TV 3', 5000);

    await page.reload(); // "the next day"
    await page.waitForSelector('.channel');
    check('TV: the last channel is back', await waitFor(page, () => document.getElementById('np-name').textContent === 'NO: TV 3', 10000), (await playing()).name);
    await page.click('.section-btn[data-section="movie"]');
    check('MOVIES: TV stops, nothing plays by itself', (await playing()).name === 'No channel selected');
    await page.click('#movie-categories [data-category="__continue__"]');
    await clickCard(page, '#movie-grid .movie-card');
    await page.waitForSelector('#md-play', { visible: true });
    const movieButton = await page.$eval('#md-play', (b) => b.textContent);
    check('MOVIES: the movie is ready to resume', /^▶ Resume \(1:[23]\d\)$/.test(movieButton), movieButton);
    await page.click('#md-close');
    await page.click('.section-btn[data-section="series"]');
    await page.click('#series-categories [data-category="__continue__"]');
    await clickCard(page, '#series-grid .movie-card');
    await page.waitForSelector('#sd-play', { visible: true });
    const seriesButton = await page.$eval('#sd-play', (b) => b.textContent);
    check('SERIES: the episode is ready to resume', seriesButton.startsWith('▶ Resume watching (S1 E1'), seriesButton);
    await page.click('#sd-play');
    check('and resumes where it was left', await waitFor(page, () => { const v = document.getElementById('video'); return !v.paused && v.currentTime > 50 && v.currentTime < 70; }, 30000));
    const stored = await page.evaluate(() => localStorage.getItem('ipman.progress') + localStorage.getItem('ipman.lastChannel'));
    check('progress and last channel are saved without the password', !stored.includes('testpass'), stored);
    check('no page errors', !page.errors.length, page.errors.join('; '));
    await page.close();
  },

  async seriesView(check) {
    const episodeFile = media.movieAac(); // 2:30 long
    const episodes = [
      ['Series: Spanish', 'Breaking Bad (ES) S01 E01', 9001], ['Series: Spanish', 'Breaking Bad (ES) S01 E02', 9002],
      ['Series: Spanish', 'Breaking Bad (ES) S01 E03', 9003], ['Series: Spanish', 'Breaking Bad (ES) S02 E01', 9004],
      ['Series: Swedish', 'SE:Trespasses (2025) S01 E01', 9101],
    ];
    const lines = ['#EXTM3U'];
    for (const [group, name, id] of episodes) {
      files.set(`/series/testuser/testpass/${id}.mkv`, episodeFile);
      lines.push(`#EXTINF:-1 group-title="${group}",${name}`, `${MEDIA}/series/testuser/testpass/${id}.mkv`);
    }
    lines.push('#EXTINF:-1 group-title="Norway - Sport",NO: TV 2', `${MEDIA}/live/testuser/testpass/1.ts`);
    playlists.set('/xtream.m3u', lines.join('\n'));
    const page = await openApp(`${MEDIA}/get.php?username=testuser&password=testpass&type=m3u_plus`, 'series');
    const $text = (sel) => page.$eval(sel, (e) => e.textContent);
    const cards = () => page.$$eval('#series-grid .movie-card', (cs) => cs.map((c) => ({
      title: c.querySelector('.movie-title').textContent, meta: c.querySelector('.movie-meta').textContent,
      counts: c.querySelector('.series-counts').textContent, tag: c.querySelector('.poster-tag')?.textContent ?? '', progress: !!c.querySelector('.watch-bar'),
    })));
    const categories = () => page.$$eval('#series-categories .category', (bs) => bs.map((b) => b.querySelector('.category-name').textContent + ' ' + b.querySelector('.category-count').textContent).join(' | '));
    const rows = () => page.$$eval('#episode-list .episode', (rs) => rs.map((r) => ({
      title: r.querySelector('.episode-title').textContent, meta: r.querySelector('.episode-meta').textContent,
      current: r.ariaCurrent === 'true', bar: parseFloat(r.querySelector('.watch-bar > span').style.width),
    })));
    const openSeries = async (title) => {
      const i = (await cards()).findIndex((c) => c.title === title);
      await clickCard(page, '#series-grid .movie-card', i);
      await page.waitForSelector('#sd-play', { visible: true });
    };

    await page.waitForSelector('#series-grid .movie-card');
    await waitFor(page, () => document.querySelector('#series-grid .movie-rating'), 15000);
    const all = await cards();
    check('grid shows the two series, no TV channel', all.map((c) => c.title).join() === 'Breaking Bad (ES),Trespasses', JSON.stringify(all));
    const bb = all[0];
    check('card: rating, year, category, seasons and episodes', bb.meta === '★ 8.92008Spanish' && bb.counts === '2 seasons · 4 episodes', JSON.stringify(bb));
    check('card: tag from the name, singular counts', all[1].tag === 'SE' && all[1].counts === '1 season · 1 episode', JSON.stringify(all[1]));
    check('categories: all, continue watching, favorites, groups', (await categories()) === 'All series 2 | ▶ Continue watching 0 | ★ Favorites 0 | Spanish 1 | Swedish 1', await categories());

    await openSeries('Breaking Bad (ES)');
    await waitFor(page, () => document.getElementById('sd-plot').textContent.length > 0, 15000);
    check('details: plot, genre, creator, cast', (await $text('#sd-plot')).startsWith('A chemistry teacher') && (await $text('#sd-facts')).includes('Drama, Crime') && (await $text('#sd-meta')).includes('Vince Gilligan'));
    check('details: seasons and episodes', (await $text('#sd-facts')).includes('2 seasons · 4 episodes'), await $text('#sd-facts'));
    check('new series: "Start watching" the first episode, with its title', (await $text('#sd-play')) === '▶ Start watching (S1 E1 · Pilot)', await $text('#sd-play'));
    await page.click('#sd-play');
    check('the player shows and plays', await waitFor(page, () => document.getElementById('app').classList.contains('series-playing') && !document.getElementById('video').paused, 30000));
    const tabs = await page.$$eval('.season-tab', (ts) => ts.map((t) => t.textContent + (t.ariaSelected === 'true' ? '*' : '')));
    check('season tabs under the player, season 1 selected', tabs.join() === 'Season 1*,Season 2', tabs.join());
    let r = await rows();
    check('episodes of the season with titles, the playing one highlighted', r.map((x) => x.title).join('|') === "1. Pilot|2. Cat's in the Bag...|3. ...And the Bag's in the River" && r[0].current, JSON.stringify(r));
    check('now playing: series and episode', (await $text('#np-name')) === 'Breaking Bad (ES)' && (await $text('#np-group')) === 'S1 E1 · Pilot', (await $text('#np-name')) + ' / ' + (await $text('#np-group')));
    check('"← Series" button', await page.$eval('#back-btn', (b) => getComputedStyle(b).display !== 'none' && b.textContent === '← Series'));

    await seekTo(page, 75, 150);
    await waitFor(page, () => document.getElementById('video').currentTime > 76 && !document.getElementById('video').paused, 15000);
    await page.keyboard.press('Space'); // pause: saves the position
    await waitFor(page, () => document.getElementById('video').paused, 3000);
    r = await rows();
    check('half watched: the bar is half full', r[0].bar > 45 && r[0].bar < 60 && /left/.test(r[0].meta), JSON.stringify(r[0]));
    await page.click('#back-btn');
    check('back to the grid, playback stopped', await page.evaluate(() => !document.getElementById('app').classList.contains('series-playing') && document.getElementById('video').paused));
    check('"Continue watching" has the series', (await categories()).includes('▶ Continue watching 1'), await categories());
    check('the card shows progress', (await cards())[0].progress);

    await openSeries('Breaking Bad (ES)');
    check('"Resume watching" the started episode', (await $text('#sd-play')) === '▶ Resume watching (S1 E1 · Pilot)', await $text('#sd-play'));
    await page.click('#sd-play');
    check('resumes where it was left', await waitFor(page, () => { const v = document.getElementById('video'); return !v.paused && v.currentTime > 65 && v.currentTime < 90; }, 30000),
      String(await video(page, () => document.getElementById('video').currentTime)));

    await seekTo(page, 146, 150);
    check('at the end, the next episode plays by itself', await waitFor(page, () => document.getElementById('np-group').textContent.startsWith('S1 E2') && !document.getElementById('video').paused, 40000), await $text('#np-group'));
    r = await rows();
    check('finished episode: full bar, "Watched"', r[0].bar === 100 && r[0].meta.startsWith('Watched') && r[1].current, JSON.stringify(r.slice(0, 2)));
    await page.click('.season-tab[data-season="2"]');
    r = await rows();
    check('another season: its episodes', r.map((x) => x.title).join() === '1. Seven Thirty-Seven', JSON.stringify(r));

    await page.reload();
    await page.waitForSelector('#series-grid .movie-card');
    await page.click('#series-categories [data-category="__continue__"]');
    check('after a reload, "Continue watching" still lists it', (await cards()).map((c) => c.title).join() === 'Breaking Bad (ES)');
    await openSeries('Breaking Bad (ES)');
    await waitFor(page, () => /·/.test(document.getElementById('sd-play').textContent), 15000);
    check('progress kept: resumes at the next episode', (await $text('#sd-play')) === "▶ Resume watching (S1 E2 · Cat's in the Bag...)", await $text('#sd-play'));
    await page.click('#sd-fav');
    await page.click('#sd-close');
    check('favorite series', (await categories()).includes('★ Favorites 1'), await categories());
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
    await waitFor(page, () => document.getElementById('video').readyState >= 2, 15000); // its first frame is in
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
    const page = await openApp(url, 'movie');
    await playMovie(page);
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
    await seekTo(page, 20, 150);
    await sleep(2500);
    const back = await video(page, () => document.getElementById('video').currentTime);
    check('seeking back stays there (no jump to data buffered further on)', back > 19 && back < 30, String(back));
    check('no page errors', !page.errors.length, page.errors.join('; '));
    await page.close();
  },

  async refusedMovie(check) {
    const url = playlist('refused', [{ name: 'Gone Movie (2011)', group: 'Movies: Nordic', url: `${MEDIA}/refused/movie/u/p/9.mp4` }]);
    const page = await openApp(url, 'movie');
    await playMovie(page);
    const shown = await waitFor(page, () => document.getElementById('overlay').classList.contains('error'), 20000);
    const text = await page.$eval('#overlay', (o) => o.textContent);
    check('a file the provider refuses says so, with the HTTP status', shown && text.includes('HTTP 400') && text.includes('provider'), text);
    await page.close();
  },

  async eac3Movie(check) {
    const url = playlist('eac3', [{ name: '4K-NC:Test Movie - 2025', group: 'Movies: Nordic 4K', file: media.movieEac3(), path: '/movie/u/p/2.mkv' }]);
    const page = await openApp(url, 'movie');
    const requests = [];
    // Only count requests for the movie itself, not the Xtream API calls (player_api.php) that go through /proxy too.
    page.on('request', (r) => { const u = new URL(r.url()); if (!(u.searchParams.get('url') ?? '').includes('player_api')) requests.push(u.pathname); });
    await playMovie(page);
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
    await page.waitForSelector(ready.movie);
    requests.length = 0;
    await playMovie(page); // resumes near 1:40 (it was watched there)
    await waitFor(page, () => document.getElementById('video').webkitAudioDecodedByteCount > 0, 60000);
    check('second start goes straight to /transcode', !requests.includes('/proxy') || requests.indexOf('/transcode') < requests.indexOf('/proxy'), [...new Set(requests)].join(' → '));
    await chooseSubtitle(page, 'Norwegian');
    await nextCue(page, 20000);
    await sleep(3000); // let every subtitle poll land
    const duplicates = await video(page, () => {
      const track = [...document.getElementById('video').textTracks].find((t) => t.mode === 'showing');
      const seen = new Set();
      let dupes = 0;
      for (const cue of track?.cues ?? []) {
        const key = `${cue.startTime}|${cue.text}`;
        if (seen.has(key)) dupes++;
        seen.add(key);
      }
      return { dupes, total: seen.size };
    });
    check('replayed within hours: each subtitle once, not twice', duplicates.total > 0 && duplicates.dupes === 0, JSON.stringify(duplicates));
    await page.close();
  },

  async heavyMovie(check) {
    const url = playlist('heavy', [{ name: '4K-NC:Heavy - 2025', group: 'Movies: Nordic 4K', file: media.heavyEac3(), path: '/movie/u/p/3.mkv' }]);
    const page = await openApp(url, 'movie');
    await playMovie(page);
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
    if (process.env.E2E_STACK) console.log(err.stack);
  }
}
await browser.close();
mediaServer.close();
console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
