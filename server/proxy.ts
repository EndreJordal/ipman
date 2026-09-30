/**
 * Stream proxy.
 *
 * GET /proxy?url=<encoded upstream URL> fetches the upstream resource server-side, which
 * sidesteps CORS and mixed-content (http stream on an https page) restrictions.
 * HLS playlists are rewritten so every segment, key and variant also goes through the proxy.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { PROXY_PATH, proxyUrl } from '../src/lib/proxy.ts';
import { pathOf, sendError, targetFromQuery } from './http.ts';
import { tapForResponse } from './mkv-subtitles.ts';

/** Time allowed for the upstream to send response headers. Bodies (live streams) may run forever. */
const HEADERS_TIMEOUT_MS = 15_000;
const FORWARD_REQUEST_HEADERS = ['range', 'accept', 'user-agent'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
/** Tags that only appear in HLS media/master playlists, not in IPTV channel lists. */
const HLS_MARKER = /#EXT-X-(TARGETDURATION|STREAM-INF)/;

function rewriteHlsPlaylist(text: string, baseUrl: string): string {
  const toProxy = (uri: string) => proxyUrl(new URL(uri, baseUrl).href);
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${toProxy(uri)}"`);
      }
      return toProxy(trimmed);
    })
    .join('\n');
}

function looksLikePlaylist(contentType: string, url: string): boolean {
  if (/mpegurl/i.test(contentType)) return true;
  return /\.m3u8?$/i.test(new URL(url).pathname);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');

  const target = targetFromQuery(req);
  if (!target) return sendError(res, 400, 'Missing or invalid ?url= parameter (http or https only)');

  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  // Some providers only accept specific players, e.g. IPMAN_USER_AGENT="VLC/3.0.20 LibVLC/3.0.20".
  if (process.env.IPMAN_USER_AGENT) headers['user-agent'] = process.env.IPMAN_USER_AGENT;

  // Abort the upstream request when the browser goes away (channel switch, tab closed).
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const timer = setTimeout(() => abort.abort(new Error('upstream timed out')), HEADERS_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method, headers, signal: abort.signal });
  } catch (err) {
    return sendError(res, 502, `Upstream request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  res.statusCode = upstream.status;
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }

  const finalUrl = upstream.url || target.href;
  if (upstream.ok && req.method === 'GET' && looksLikePlaylist(upstream.headers.get('content-type') ?? '', finalUrl)) {
    let text = await upstream.text();
    if (HLS_MARKER.test(text)) text = rewriteHlsPlaylist(text, finalUrl);
    res.setHeader('cache-control', 'no-store');
    res.end(text);
    return;
  }

  // fetch() transparently decompresses, so the upstream length is only valid for identity encoding.
  const length = upstream.headers.get('content-length');
  if (length && !upstream.headers.has('content-encoding')) res.setHeader('content-length', length);

  if (!upstream.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as unknown as NodeReadableStream);
  body.on('error', () => res.destroy());
  // MKV movies: read their text subtitles from the bytes on their way to the browser.
  const tap = tapForResponse(target.href, upstream.headers.get('content-type') ?? '', upstream.headers.get('content-range'));
  if (tap) body.on('data', (chunk: Buffer) => tap.write(chunk));
  body.pipe(res);
}

export function proxyMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (pathOf(req) !== PROXY_PATH) return next();
  handle(req, res).catch((err: Error) => sendError(res, 502, `Proxy error: ${err.message}`));
}
