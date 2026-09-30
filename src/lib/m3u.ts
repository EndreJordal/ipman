/** Live TV, a movie, or an episode of a series. */
export type ChannelKind = 'live' | 'movie' | 'series';

export interface Channel {
  /** Stream URL; also the channel's stable key (favorites, last channel). */
  url: string;
  name: string;
  group: string;
  kind: ChannelKind;
  logo?: string;
  tvgId?: string;
}

/**
 * Tells movies and series from live TV by the stream URL. Xtream-style providers put them under
 * /movie/… and /series/…; otherwise a video-file extension means a movie. Group names aren't
 * used: public lists name groups of live 24/7 channels "Series" or "Movies".
 */
export function channelKind(url: string): ChannelKind {
  if (/\/series\//i.test(url)) return 'series';
  if (/\/movie\//i.test(url) || /\.(mkv|mp4|avi|m4v|mov)(\?|$)/i.test(url)) return 'movie';
  return 'live';
}

export interface Playlist {
  channels: Channel[];
  /** XMLTV guide URL from the #EXTM3U header, if any. */
  epgUrl?: string;
}

const UNGROUPED = 'Ungrouped';
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, key, value] of text.matchAll(ATTR_RE)) attrs[key.toLowerCase()] = value;
  return attrs;
}

/** Splits `-1 tvg-name="A, B" group-title="X",Title` at the first comma outside quotes. */
function splitExtinf(body: string): [meta: string, title: string] {
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) return [body.slice(0, i), body.slice(i + 1).trim()];
  }
  return [body, ''];
}

export function parseM3U(text: string): Playlist {
  const channels: Channel[] = [];
  let epgUrl: string | undefined;
  let info: { title: string; attrs: Record<string, string> } | null = null;
  let extGroup: string | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      const attrs = parseAttrs(line);
      epgUrl = attrs['url-tvg'] ?? attrs['x-tvg-url'];
    } else if (line.startsWith('#EXTINF:')) {
      const [meta, title] = splitExtinf(line.slice('#EXTINF:'.length));
      info = { title, attrs: parseAttrs(meta) };
    } else if (line.startsWith('#EXTGRP:')) {
      extGroup = line.slice('#EXTGRP:'.length).trim();
    } else if (!line.startsWith('#')) {
      const attrs = info?.attrs ?? {};
      const group = attrs['group-title'] || extGroup || UNGROUPED;
      channels.push({
        url: line,
        name: info?.title || attrs['tvg-name'] || line,
        group,
        kind: channelKind(line),
        logo: attrs['tvg-logo'] || undefined,
        tvgId: attrs['tvg-id'] || undefined,
      });
      info = null;
      extGroup = undefined;
    }
  }

  return { channels, epgUrl };
}

/** Splits provider groups like "Norway - Sport" into country and category; "Srbija" has no category. */
export function splitGroup(group: string): { country: string; category: string } {
  const i = group.indexOf(' - ');
  return i === -1
    ? { country: group.trim(), category: '' }
    : { country: group.slice(0, i).trim(), category: group.slice(i + 3).trim() };
}
