# ipman

A personal IPTV viewer for M3U playlists. Built with Vite and TypeScript, using hls.js and mpegts.js for playback.

## Requirements

- [Node.js](https://nodejs.org/) **24 or newer**. The server runs its TypeScript files directly, which older versions can't do. Check with `node -v`.
- Git, to clone the repo.
- Windows, for the optional autostart below. The app itself runs anywhere Node does.
- Recommended: [ffmpeg](https://ffmpeg.org/), for channels and movies with Dolby or DTS audio (AC-3, E-AC-3, DTS, TrueHD), which browsers can't play. With ffmpeg installed, ipman converts their audio to AAC automatically. Without it, such channels show an error and such movies play without sound. On Windows: `winget install --id Gyan.FFmpeg -e`.

## Install and run

```sh
git clone https://github.com/EndreJordal/ipman.git
cd ipman
npm install
npm start          # builds, then serves the app at http://127.0.0.1:5173
```

> **Windows PowerShell:** if `npm` fails with *"running scripts is disabled on this system"*, either use `npm.cmd` instead of `npm` (e.g. `npm.cmd start`), or allow local scripts for your user once:
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```

On first launch the settings dialog opens: paste your M3U URL and press **Save & reload playlist**.

`npm start` runs [server/index.ts](server/index.ts), a small standalone Node server. It serves the built app together with the stream proxy and the TV guide service.

### Start automatically at login (Windows)

```sh
npm run autostart:install     # register a logon task and start the server now
npm run autostart:status      # is it running? shows the last log lines
npm run autostart:restart     # restart it, e.g. after updating (see below)
npm run autostart:uninstall   # stop it and remove the logon task
```

The server runs as a scheduled task named `ipman`, with no window at all. It uses `conhost --headless`, because on Windows 11 a "hidden" PowerShell window still shows up in Windows Terminal, and closing that window would stop the server. You can close the terminal you ran the command in.

The log is written to `.cache/server.log`.

### Updating

```sh
git pull
npm install                   # only needed when dependencies changed, but harmless every time
npm run autostart:restart     # rebuilds the app and restarts the server
```

**Updating an install from before Dolby audio support:** install ffmpeg once (`winget install --id Gyan.FFmpeg -e`), open a new terminal so it's on the PATH, then run the three commands above. If Dolby channels still say ffmpeg isn't installed, sign out of Windows and back in, so the autostart task picks up the new PATH.

### Development

```sh
npm run dev        # http://127.0.0.1:5174, with instant reload
```

The dev server uses port 5174 so it can run next to the standalone server. Browsers store data per port, so its settings and favorites are separate from the ones on 5173.

## Features

- **Channel list** with search, logos and favorites. It's virtualized, so large playlists stay fast.
  - Two dropdowns, country and category, built from `Country - Category` group names.
  - Collapsible, so the video can take the full width.
- **Playback**
  - HLS (`.m3u8`) through hls.js, or natively in Safari.
  - Raw MPEG-TS (`.ts`, common with Xtream-style providers) through mpegts.js.
  - Movies (MKV, MP4) through the browser's own player.
  - URLs without a file extension are probed once per server.
  - A 3-second buffer before starting and after stalls.
- **Control bar**
  - Play/pause, volume, subtitles, fullscreen, and a ⋮ menu (picture-in-picture, reload stream).
  - Live streams show a LIVE badge. Movies get a seek bar with elapsed and total time.
  - Hides after 3 seconds without mouse movement.
- **Resolution pill:** grey for SD, white 720p, gold 1080p, red 2160p.
- **Subtitles**, all off until chosen in the CC menu:
  - HLS WebVTT subtitles and embedded CEA-608/708 captions.
  - DVB bitmap subtitles in MPEG-TS channels, decoded in the browser ([src/lib/dvb-subtitle-decoder.ts](src/lib/dvb-subtitle-decoder.ts)).
  - Text subtitles (SRT, ASS) embedded in MKV movies. The proxy reads them out of the movie data as it passes through ([server/mkv-subtitles.ts](server/mkv-subtitles.ts)).
- **Dolby and DTS audio** are converted to AAC by ffmpeg ([server/transcode.ts](server/transcode.ts)). This works for live channels and MKV movies, including skipping, and is detected automatically.
- **TV guide** (see below).
- **Remembers** the last channel, volume, filters, favorites and sidebar state.
- Caches the playlist in IndexedDB and refreshes it once it's older than 24 hours.

### Keyboard

| Key         | Action                      |
| ----------- | --------------------------- |
| ↑ / ↓       | Previous / next channel     |
| ← / →       | Back / forward 10 s (movies)|
| Space       | Pause / play                |
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

- **Codecs.** H.264 with AAC works everywhere. HEVC depends on the browser and OS; Chrome and Edge on Windows handle it when hardware support is present.
- **Dolby/DTS conversion**
  - Video and subtitles are copied unchanged; only the audio is converted, to stereo AAC (surround is mixed down). It costs a few percent of one CPU core.
  - Channels and movies that needed converting are remembered and start converted next time.
  - Converted movies are streamed at playback speed, which keeps them under Chrome's ~150 MB buffer limit even at 4K. Skipping in them restarts ffmpeg and takes a few seconds.
  - MP4 movies with Dolby audio aren't detected yet (MKV only).
- **Subtitles**
  - Teletext subtitles aren't supported.
  - Neither are bitmap subtitles in movies (PGS, VobSub).
  - DVB subtitles appear from the next broadcast line after you choose a language.
- UDP multicast (`udp://…`) and DRM-protected streams can't be played in a browser.
