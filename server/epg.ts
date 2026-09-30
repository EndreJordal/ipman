/**
 * TV guide service.
 *
 * GET /epg?url=<encoded XMLTV URL>[&force=1] downloads the XMLTV file (often 50–300 MB,
 * sometimes gzipped), keeps only programmes near the current time, and returns a compact
 * JSON Guide. Results are cached in memory and on disk, because Xtream servers can take
 * tens of seconds to generate xmltv.php.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline, Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { Parser } from 'htmlparser2';
import { EPG_PATH, normalizeName, type Guide, type Programme } from '../src/lib/epg.ts';
import { pathOf, sendError, targetFromQuery } from './http.ts';
import { DATA_DIR } from './paths.ts';

const CACHE_DIR = path.join(DATA_DIR, 'epg');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HEADERS_TIMEOUT_MS = 90_000;
/** A whole download, however slowly the server sends it. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** Guides in memory (a few MB each): one per provider in use is plenty. */
const MEMORY_ENTRIES = 2;
/** Guide files on disk that haven't been used this long are deleted. */
const DISK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Programme window kept relative to download time. Must outlast CACHE_TTL + the client refresh interval. */
const KEEP_PAST_MS = 60 * 60 * 1000;
const KEEP_AHEAD_MS = 16 * 60 * 60 * 1000;
const MAX_DESC_LENGTH = 300;
/** Stop time assumed for a channel's last programme when the guide omits it. */
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  json: string;
}

const memoryCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

/** Parses XMLTV times like "20260928190000 +0200" to epoch ms. */
function parseXmltvTime(value: string | undefined): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?/.exec(value?.trim() ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0', sign, oh = '0', om = '0'] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const offset = sign ? (sign === '-' ? -1 : 1) * (+oh * 60 + +om) * 60_000 : 0;
  return utc - offset;
}

/** Yields the body, gunzipping it if it starts with the gzip magic bytes (e.g. an epg.xml.gz file). */
async function* decompressIfGzipped(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const it = body[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  async function* all() {
    yield first.value;
    for (let next = await it.next(); !next.done; next = await it.next()) yield next.value;
  }
  if (first.value[0] === 0x1f && first.value[1] === 0x8b) {
    yield* pipeline(Readable.from(all()), createGunzip(), () => {});
  } else {
    yield* all();
  }
}

async function parseXmltv(chunks: AsyncIterable<Uint8Array>): Promise<Guide> {
  const now = Date.now();
  const from = now - KEEP_PAST_MS;
  const to = now + KEEP_AHEAD_MS;
  const programmes: Record<string, Programme[]> = {};
  const names: Record<string, string> = {};

  let channelId: string | null = null;
  let programme: (Programme & { channel: string }) | null = null;
  let capture: 'display-name' | 'title' | 'desc' | null = null;
  let text = '';

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        switch (name) {
          case 'channel':
            channelId = attrs.id?.toLowerCase() || null;
            break;
          case 'display-name':
            if (channelId) [capture, text] = [name, ''];
            break;
          case 'programme': {
            const start = parseXmltvTime(attrs.start);
            // A missing stop is filled in from the next programme's start below.
            const stop = parseXmltvTime(attrs.stop) ?? NaN;
            const inWindow = start !== null && start < to && (Number.isNaN(stop) ? start > from - DEFAULT_DURATION_MS : stop > from);
            programme = attrs.channel && inWindow ? { channel: attrs.channel.toLowerCase(), start, stop, title: '' } : null;
            break;
          }
          case 'title':
          case 'desc':
            // Guides may repeat these per language; keep the first.
            if (programme && !programme[name]) [capture, text] = [name, ''];
            break;
        }
      },
      ontext(chunk) {
        if (capture) text += chunk;
      },
      onclosetag(name) {
        if (name === capture) {
          const value = text.trim();
          capture = null;
          if (name === 'display-name') {
            if (channelId && value) names[normalizeName(value)] ??= channelId;
          } else if (programme && value) {
            if (name === 'title') programme.title = value;
            else programme.desc = value.length > MAX_DESC_LENGTH ? `${value.slice(0, MAX_DESC_LENGTH - 1).trimEnd()}…` : value;
          }
        } else if (name === 'programme' && programme) {
          const { channel, ...entry } = programme;
          if (entry.title) (programmes[channel] ??= []).push(entry);
          programme = null;
        } else if (name === 'channel') {
          channelId = null;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );

  const decoder = new TextDecoder();
  for await (const chunk of chunks) parser.write(decoder.decode(chunk, { stream: true }));
  parser.write(decoder.decode());
  parser.end();

  for (const [id, list] of Object.entries(programmes)) {
    list.sort((a, b) => a.start - b.start);
    list.forEach((p, i) => {
      if (Number.isNaN(p.stop)) p.stop = list[i + 1]?.start ?? p.start + DEFAULT_DURATION_MS;
    });
    const kept = list.filter((p, i) => p.stop > from && p.start !== list[i - 1]?.start);
    if (kept.length) programmes[id] = kept;
    else delete programmes[id];
  }

  return { fetchedAt: now, programmes, names };
}

async function downloadGuide(url: string): Promise<CacheEntry> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('guide server timed out')), HEADERS_TIMEOUT_MS);
  const headers = process.env.IPMAN_USER_AGENT ? { 'user-agent': process.env.IPMAN_USER_AGENT } : undefined;
  let res: Response;
  try {
    // The overall deadline also covers a server that trickles the file out forever.
    res = await fetch(url, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !res.body) throw new Error(`guide server returned HTTP ${res.status}`);

  const started = Date.now();
  const guide = await parseXmltv(decompressIfGzipped(Readable.fromWeb(res.body as unknown as NodeReadableStream)));
  const count = Object.values(guide.programmes).reduce((n, list) => n + list.length, 0);
  console.log(`[epg] ${count} programmes for ${Object.keys(guide.programmes).length} channels (${Date.now() - started} ms)`);
  return { fetchedAt: guide.fetchedAt, json: JSON.stringify(guide) };
}

function cacheFile(url: string): string {
  return path.join(CACHE_DIR, `${createHash('sha1').update(url).digest('hex')}.json`);
}

/** Keeps the entry, as the most recently used, and drops the least recently used beyond the limit. */
function remember(url: string, entry: CacheEntry): void {
  memoryCache.delete(url);
  memoryCache.set(url, entry);
  while (memoryCache.size > MEMORY_ENTRIES) memoryCache.delete(memoryCache.keys().next().value!);
}

async function readCache(url: string): Promise<CacheEntry | undefined> {
  const hit = memoryCache.get(url);
  if (hit) {
    remember(url, hit);
    return hit;
  }
  try {
    const json = await readFile(cacheFile(url), 'utf8');
    const entry = { fetchedAt: (JSON.parse(json) as Guide).fetchedAt, json };
    remember(url, entry);
    return entry;
  } catch {
    return undefined;
  }
}

/** Deletes guide files not written for a week (old providers, old credentials). */
async function pruneDiskCache(): Promise<void> {
  const files = await readdir(CACHE_DIR).catch(() => [] as string[]);
  for (const name of files) {
    const file = path.join(CACHE_DIR, name);
    const info = await stat(file).catch(() => null);
    if (info && Date.now() - info.mtimeMs > DISK_MAX_AGE_MS) await unlink(file).catch(() => {});
  }
}

async function getGuide(url: string, force: boolean): Promise<CacheEntry> {
  const cached = await readCache(url);
  if (cached && !force && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  let pending = inflight.get(url);
  if (!pending) {
    pending = downloadGuide(url)
      .then(async (entry) => {
        remember(url, entry);
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cacheFile(url), entry.json);
        void pruneDiskCache();
        return entry;
      })
      .finally(() => inflight.delete(url));
    inflight.set(url, pending);
  }

  try {
    return await pending;
  } catch (err) {
    if (cached) {
      console.warn(`[epg] refresh failed, serving cached guide: ${(err as Error).message}`);
      return cached;
    }
    throw err;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const params = new URL(req.url ?? '', 'http://localhost').searchParams;
  const target = targetFromQuery(req);
  if (!target) return sendError(res, 400, 'Missing or invalid ?url= parameter');

  const entry = await getGuide(target.href, params.has('force'));
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(entry.json);
}

export function epgMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (pathOf(req) !== EPG_PATH) return next();
  handle(req, res).catch((err: Error) => {
    console.warn(`[epg] ${err.message}`);
    sendError(res, 502, `Could not load guide: ${err.message}`);
  });
}
