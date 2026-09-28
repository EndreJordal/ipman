/** Path served by the stream proxy in server/proxy.ts. */
export const PROXY_PATH = '/proxy';

export function proxyUrl(target: string): string {
  return `${PROXY_PATH}?url=${encodeURIComponent(target)}`;
}
