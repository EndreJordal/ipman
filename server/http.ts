/** Small HTTP helpers shared by ipman's services (proxy, transcode, guide, movie info, version). */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Answers with a plain-text error, or cuts the connection if the response has already started. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
}

/** The http(s) URL in `?url=`, or null. */
export function targetFromQuery(req: IncomingMessage): URL | null {
  try {
    const target = new URL(new URL(req.url ?? '', 'http://localhost').searchParams.get('url') ?? '');
    return target.protocol === 'http:' || target.protocol === 'https:' ? target : null;
  } catch {
    return null;
  }
}

/** The request path without the query. */
export const pathOf = (req: IncomingMessage) => req.url?.split('?')[0] ?? '';

const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Whether a request may use ipman. The server only listens on this computer, but web pages
 * can still send requests to it: a page on another site through the browser (an <img> or form
 * pointing at /proxy or /transcode), or through a DNS name rebound to 127.0.0.1. So:
 * - the Host header must be this computer (a rebound name has the other site's name there);
 * - requests the browser marks as coming from another site are refused. ffmpeg's own requests
 *   to /proxy (and curl) send no such header and are allowed.
 */
export function isAllowedRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  const m = /^(.*?)(?::(\d+))?$/.exec(host)!;
  const extra = process.env.HOST?.toLowerCase();
  if (!LOCAL_NAMES.has(m[1]) && m[1] !== extra) return false;
  if (m[2] && Number(m[2]) !== req.socket.localPort) return false;
  const site = req.headers['sec-fetch-site'];
  return site !== 'cross-site' && site !== 'same-site';
}
