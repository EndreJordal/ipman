# ipman

A personal IPTV viewer for M3U playlists, running in your browser. It plays live channels and movies from your own IPTV subscription, with a TV guide, subtitles, and automatic conversion of Dolby audio that browsers can't play.

> **ipman is a player only.** It comes with no channels, playlists or other content. You need your own IPTV subscription and its M3U playlist URL.

## Install (Windows 10 and 11)

Open **PowerShell** (Start menu → type "PowerShell") and paste:

```powershell
irm https://github.com/EndreJordal/ipman/releases/latest/download/install.ps1 | iex
```

The installer asks one question, whether ipman should start when you log in, and then:

- **Downloads ipman** from this repository's releases, **Node.js** from nodejs.org and **ffmpeg** from gyan.dev. Every download is checked against its published SHA-256 checksum; if one doesn't match, nothing is changed.
- **Installs** into `%LOCALAPPDATA%\Programs\ipman`, for your user only. It needs no admin rights, and adds nothing to the PATH or system-wide. Node.js and ffmpeg are private copies that don't interfere with anything else.
- **Adds** a Start-menu entry "ipman" and an entry under Settings → Apps → Installed apps, plus the autostart if you chose it.
- **Starts ipman** and opens it in your browser at http://127.0.0.1:5173.

On first launch the settings dialog opens: paste your M3U URL and press **Save & reload playlist**.

> **Bookmark http://127.0.0.1:5173/** (Ctrl+D) to find ipman again, or open it from the Start menu: **ipman**.
> Always use exactly this address: your settings and favorites are stored in the browser for it.

**Want to read the installer before running it?** It's [install.ps1](install.ps1) in this repository. You can also download it, read it, and run it yourself:

```powershell
irm https://github.com/EndreJordal/ipman/releases/latest/download/install.ps1 -OutFile install-ipman.ps1
notepad install-ipman.ps1
powershell -ExecutionPolicy Bypass -File install-ipman.ps1
```

**Installer options**, for example to skip the question:

```powershell
& ([scriptblock]::Create((irm https://github.com/EndreJordal/ipman/releases/latest/download/install.ps1))) -NoAutostart
```

| Option | Effect |
| --- | --- |
| `-Autostart` / `-NoAutostart` | Answer "start when you log in?" in advance |
| `-NoBrowser` | Don't open the browser after installing |
| `-Uninstall` | Remove ipman |
| `-Path <folder>` | Install somewhere else |

### Updating

When a new version is out, ipman shows a dot on the settings gear, and the settings dialog shows the command to copy. It's the same install command: **running it again updates ipman in place**. Settings and favorites are stored in your browser and are kept.

You can switch off the update check under Settings → *Check for updates*. The check contacts GitHub at most twice a day and sends nothing but a normal web request.

### Uninstalling

Settings → Apps → Installed apps → **ipman** → Uninstall. Or run the install command with `-Uninstall`. This removes the program, its shortcuts, the autostart and its cache. Settings and favorites stay in your browser until you clear the site data for `127.0.0.1`.

### Troubleshooting

- **"running scripts is disabled on this system":** this doesn't apply to the `irm … | iex` command above. It only affects running a downloaded `.ps1` file directly. Use the `-ExecutionPolicy Bypass` form shown above.
- **"Port 5173 is in use by …":** another program uses ipman's port. Close it and run the installer again.
- **Smart App Control or antivirus blocks something:** everything ipman runs is the official, signed `node.exe` from the Node.js project and the ffmpeg build from gyan.dev. Don't download ipman as a zip through your browser: files downloaded that way are marked "from the internet", and Smart App Control blocks some of them without a way to allow them. The install command doesn't have that problem.
- **ipman doesn't start:** the log is in `%LOCALAPPDATA%\ipman\server.log`.

## Development

Requirements: [Node.js](https://nodejs.org/) 24 or newer and Git. For Dolby conversion while developing, also ffmpeg on the PATH (`winget install --id Gyan.FFmpeg -e`).

```sh
git clone https://github.com/EndreJordal/ipman.git
cd ipman
npm install
npm run dev        # http://127.0.0.1:5174, with instant reload
```

The dev server uses port 5174 so it can run next to an installed ipman on 5173. Browsers store data per port, so its settings and favorites are separate.

> **Windows PowerShell:** if `npm` fails with *"running scripts is disabled on this system"*, use `npm.cmd` instead of `npm`, or allow local scripts for your user once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with instant reload (port 5174) |
| `npm start` | Builds and runs the standalone server from the checkout (port 5173) |
| `npm run typecheck` | Type checks, including a check that server code runs with Node's type stripping |
| `npm run package` | Builds the release package into `build/release/` |
| `npm run test:e2e` | Browser tests against a running ipman (`-- --base http://127.0.0.1:5174`) |
| `powershell -File tests\install-smoke.ps1` | Installs `build/release` in a temporary folder, checks it, uninstalls |

### Releasing

1. Bump `version` in `package.json` and commit.
2. `git tag v0.2.0 && git push origin v0.2.0` (with the new version).
3. GitHub Actions ([release.yml](.github/workflows/release.yml)) type checks, builds the package, tests the installer on Windows, and publishes the release. The install command always fetches the latest release.

**How the package works:** the frontend is bundled by Vite as usual. The server, including its one dependency (htmlparser2), is bundled into a single `server.mjs`, so the installed app needs no `node_modules`. [server/paths.ts](server/paths.ts) tells the two layouts apart: an installed package or a project checkout.

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
- It runs inside the ipman server: installed, or from a checkout (`npm start`, `npm run dev`). A `dist/` build hosted elsewhere can only play streams directly.
- It binds to `127.0.0.1` because it will fetch any URL it's given. Don't expose it to a network.
- If a provider rejects browser user agents, set one as a user environment variable, e.g. `setx IPMAN_USER_AGENT "VLC/3.0.20 LibVLC/3.0.20"`, then sign out and back in (or restart ipman).

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

## Licence

[MIT](LICENSE). ipman downloads [Node.js](https://nodejs.org/) (MIT) and [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) (GPL) from their official sources at install time; they keep their own licences.
