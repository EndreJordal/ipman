/** Path served by the stream proxy in server/proxy.ts. */
export const PROXY_PATH = '/proxy';

export function proxyUrl(target: string): string {
  return `${PROXY_PATH}?url=${encodeURIComponent(target)}`;
}

/** Path served by the audio transcoder in server/transcode.ts. */
export const TRANSCODE_PATH = '/transcode';

/** With `start`, a movie is converted from that position (seconds) and keeps its original timestamps. */
export function transcodeUrl(target: string, start?: number): string {
  const vod = start === undefined ? '' : `&start=${start.toFixed(3)}`;
  return `${TRANSCODE_PATH}?url=${encodeURIComponent(target)}${vod}`;
}

/** Path serving what the server read out of proxied MKV movies: subtitles, duration, audio codec. */
export const VOD_INFO_PATH = '/vod-info';
