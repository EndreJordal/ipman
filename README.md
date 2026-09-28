# ipman

A personal IPTV viewer for M3U playlists. Built with Vite and TypeScript, using hls.js and mpegts.js for playback.

## Run

```sh
npm install
npm start          # builds, then serves the app at http://127.0.0.1:5173
```

On first launch the settings dialog opens: paste your M3U URL and press **Save & reload playlist**.

`npm start` runs [server/index.ts](server/index.ts), a small standalone Node server. It serves the built app together with the stream proxy and the TV guide service.

### Start automatically at login (Windows)

```sh
npm run autostart:install     # register a logon task and start the server now
npm run autostart:status      # is it running? shows the last log lines
npm run autostart:restart     # restart it, e.g. after pulling code changes
npm run autostart:uninstall   # stop it and remove the logon task
```

The server runs hidden in the background as a scheduled task named `ipman`. Its log is written to `.cache/server.log`. Every restart rebuilds the app, so code changes are picked up with `autostart:restart`.

### Development

```sh
npm run dev        # http://127.0.0.1:5174, with instant reload
```

The dev server uses port 5174 so it can run next to the standalone server. Browsers store data per port, so its settings and favorites are separate from the ones on 5173.

## Features

- Channel list with groups, search, logos and favorites. The list is virtualized, so large playlists stay fast.
- Plays HLS (`.m3u8`) through hls.js, or natively in Safari.
- Plays raw MPEG-TS (`.ts`, common with Xtream-style providers) through mpegts.js.
- URLs without a file extension try HLS first, then MPEG-TS.
- Remembers the last channel, volume, selected group and favorites.
- Caches the playlist in IndexedDB and refreshes it once it's older than 24 hours.

### Keyboard

| Key         | Action                      |
| ----------- | --------------------------- |
| ↑ / ↓       | Previous / next channel     |
| F           | Fullscreen                  |
| M           | Mute                        |
| S           | Toggle favorite             |
| /           | Search                      |

## The stream proxy

Most IPTV servers don't send CORS headers, and many only serve plain `http://`. Both block playback in a browser.
[server/proxy.ts](server/proxy.ts) serves `/proxy?url=…`. It fetches the URL server-side and rewrites HLS playlists so that segments, keys and variant streams also go through the proxy.

- It's enabled by default and can be turned off in settings.
- It runs inside the ipman server (`npm start`, `npm run dev` or `npm run preview`). A `dist/` build hosted elsewhere can only play streams directly.
- It binds to `127.0.0.1` because it will fetch any URL it's given. Don't expose it to a network.
- If a provider rejects browser user agents, set one, e.g. `IPMAN_USER_AGENT="VLC/3.0.20 LibVLC/3.0.20" npm start`.

## TV guide (EPG)

The app shows the current programme under each channel name, and the current and next programme in the now-playing bar. Hover over a programme to see its description.

**Where the guide comes from.** In order of preference:
1. The guide URL set in settings.
2. The playlist's `url-tvg` header.
3. For Xtream-style playlists (`get.php?username=…&password=…`), the provider's `xmltv.php`.

**How it's processed.** [server/epg.ts](server/epg.ts) serves `/epg?url=…`:
- It downloads the XMLTV file (gzipped files are handled) and keeps programmes from 1 hour ago to 16 hours ahead.
- It returns them as compact JSON, cached on disk in `.cache/epg/` for 6 hours.
- The browser caches the result in IndexedDB and downloads it again every 3 hours.

**Matching.** Channels are matched to the guide by `tvg-id`, falling back to a normalized channel name. The settings dialog shows how many channels matched.

## Known limits

- **Codecs.** H.264 with AAC works everywhere. HEVC and AC-3/E-AC-3 audio depend on the browser and OS. Chrome and Edge on Windows handle HEVC when hardware support is present.
- UDP multicast (`udp://…`) and DRM-protected streams can't be played in a browser.
