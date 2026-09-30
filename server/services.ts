/**
 * ipman's services in one place: the stream proxy, TV guide, audio conversion, movie info and
 * version check. The standalone server (server/index.ts) and the Vite dev/preview server
 * (vite.config.ts) both run this same chain, behind the same request guard.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { epgMiddleware } from './epg.ts';
import { isAllowedRequest, sendError } from './http.ts';
import { vodInfoMiddleware } from './mkv-subtitles.ts';
import { proxyMiddleware } from './proxy.ts';
import { transcodeMiddleware } from './transcode.ts';
import { versionMiddleware } from './version.ts';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const SERVICES: Middleware[] = [proxyMiddleware, epgMiddleware, transcodeMiddleware, vodInfoMiddleware, versionMiddleware];

/** Runs the request through the guard and the services; `next` when none of them handles it. */
export function handleServices(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (!isAllowedRequest(req)) return sendError(res, 403, 'ipman only answers its own page on this computer.');
  const run = (i: number): void => (i < SERVICES.length ? SERVICES[i](req, res, () => run(i + 1)) : next());
  run(0);
}

/** For vite.config.ts: the services on the dev and preview servers. */
export function ipmanServices(): Plugin {
  return {
    name: 'ipman-services',
    configureServer(server) {
      server.middlewares.use(handleServices);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleServices);
    },
  };
}
