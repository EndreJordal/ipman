export interface Channel {
  /** Stream URL; also the channel's stable key (favorites, last channel). */
  url: string;
  name: string;
  group: string;
  logo?: string;
  tvgId?: string;
}

export interface Playlist {
  channels: Channel[];
  /** Group names in order of first appearance. */
  groups: string[];
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
  const groups = new Set<string>();
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
      groups.add(group);
      channels.push({
        url: line,
        name: info?.title || attrs['tvg-name'] || line,
        group,
        logo: attrs['tvg-logo'] || undefined,
        tvgId: attrs['tvg-id'] || undefined,
      });
      info = null;
      extGroup = undefined;
    }
  }

  return { channels, groups: [...groups], epgUrl };
}

/** Splits provider groups like "Norway - Sport" into country and category; "Srbija" has no category. */
export function splitGroup(group: string): { country: string; category: string } {
  const i = group.indexOf(' - ');
  return i === -1
    ? { country: group.trim(), category: '' }
    : { country: group.slice(0, i).trim(), category: group.slice(i + 3).trim() };
}
