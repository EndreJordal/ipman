/**
 * Audio transcoding for streams whose audio browsers can't decode (AC-3 / E-AC-3, i.e. Dolby).
 *
 * GET /transcode?url=<encoded upstream URL> runs ffmpeg on the stream: video and subtitles
 * are copied untouched, the audio is converted to stereo AAC, and the result is streamed back
 * as MPEG-TS. Converting one audio track costs a few percent of one CPU core.
 * Requires ffmpeg on the PATH (Windows: `winget install Gyan.FFmpeg`) or IPMAN_FFMPEG set to it.
 */
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { proxyUrl, TRANSCODE_PATH } from '../src/lib/proxy.ts';
import { recordTranscodeStart } from './mkv-subtitles.ts';

const FFMPEG = process.env.IPMAN_FFMPEG || 'ffmpeg';
/** Give up if ffmpeg produces no output this long after starting (unreachable stream, bad URL). */
const FIRST_OUTPUT_TIMEOUT_MS = 20_000;

let ffmpegCheck: Promise<boolean> | null = null;

/** Whether ffmpeg can be started. A negative result isn't cached, so installing it later just works. */
function ffmpegAvailable(): Promise<boolean> {
  ffmpegCheck ??= new Promise<boolean>((resolve) => {
    const probe = spawn(FFMPEG, ['-version'], { windowsHide: true, stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('exit', (code) => resolve(code === 0));
  }).then((ok) => {
    if (!ok) ffmpegCheck = null;
    return ok;
  });
  return ffmpegCheck;
}

/**
 * Finds where an MPEG-TS stream starts on the timeline: the lowest first DTS/PTS of its video
 * and audio, which is also the base mpegts.js subtracts in the browser (currentTime 0).
 */
class FirstTimestampFinder {
  private buf = Buffer.alloc(0);
  private video: number | null = null;
  private audio: number | null = null;
  private scanned = 0;
  private done = false;

  constructor(private onFound: (seconds: number) => void) {}

  push(chunk: Buffer): void {
    if (this.done) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    let i = 0;
    for (; i + 188 <= this.buf.length; i += 188) {
      if (this.buf[i] !== 0x47) {
        // Lost packet alignment: resync on the next sync byte.
        const next = this.buf.indexOf(0x47, i + 1);
        if (next < 0) break;
        i = next - 188;
        continue;
      }
      this.packet(this.buf.subarray(i, i + 188));
    }
    this.scanned += i;
    this.buf = this.buf.subarray(i);
    // Report once both are seen, or with whatever we have after the first 2 MB.
    if ((this.video !== null && this.audio !== null) || (this.scanned > 2_000_000 && (this.video ?? this.audio) !== null)) {
      this.done = true;
      this.onFound(Math.min(this.video ?? Infinity, this.audio ?? Infinity) / 90_000);
    }
  }

  private packet(p: Buffer): void {
    if (!(p[1] & 0x40)) return; // not the start of a PES packet
    const adaptation = (p[3] >> 4) & 3;
    const o = adaptation === 3 ? 5 + p[4] : 4;
    if (adaptation === 2 || o + 19 > 188 || p[o] !== 0 || p[o + 1] !== 0 || p[o + 2] !== 1) return;
    const streamId = p[o + 3];
    const flags = p[o + 7] >> 6;
    if (!(flags & 2)) return; // no PTS
    const read = (at: number) => ((p[at] >> 1) & 7) * 2 ** 30 + (p[at + 1] << 22) + ((p[at + 2] >> 1) << 15) + (p[at + 3] << 7) + (p[at + 4] >> 1);
    const ts = flags === 3 ? read(o + 14) : read(o + 9); // DTS if present, else PTS
    if (streamId >= 0xe0 && streamId <= 0xef) this.video ??= ts;
    else if ((streamId >= 0xc0 && streamId <= 0xdf) || streamId === 0xbd) this.audio ??= ts;
  }
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return void res.destroy();
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let target: URL;
  try {
    target = new URL(new URL(req.url ?? '', 'http://localhost').searchParams.get('url') ?? '');
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error();
  } catch {
    return sendError(res, 400, 'Missing or invalid ?url= parameter');
  }
  if (!(await ffmpegAvailable())) {
    return sendError(res, 501, 'ffmpeg is not installed on the ipman server');
  }

  // Movies pass `start` (seconds): seeking restarts ffmpeg there. They're read through our own
  // proxy so the MKV subtitle tap keeps working, and keep their original timestamps (-copyts),
  // so subtitles line up; the exact start of the output is reported back through /vod-info.
  const start = new URL(req.url ?? '', 'http://localhost').searchParams.get('start');
  const vod = start !== null && Number.isFinite(Number(start));
  const input = vod ? `http://127.0.0.1:${req.socket.localPort}${proxyUrl(target.href)}` : target.href;

  const userAgent = process.env.IPMAN_USER_AGENT;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // Live IPTV connections drop now and then; let ffmpeg reconnect instead of ending the stream.
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4',
    ...(userAgent && !vod ? ['-user_agent', userAgent] : []),
    // Shorter probing than the default 5 s, so the channel starts sooner.
    '-analyzeduration', '3000000', '-probesize', '3000000',
    ...(vod ? ['-ss', start] : []),
    // Movies: deliver at playback speed after a short burst. Faster, the browser's buffer fills to
    // its ~150 MB limit (under a minute of 4K), and mpegts.js never resumes loading after that.
    ...(vod ? ['-readrate', '1', '-readrate_initial_burst', '8', '-readrate_catchup', '1.5'] : []),
    '-i', input,
    ...(vod
      ? // MPEG-TS can't carry MKV text subtitles (those come from the tap); drop them and cover art.
        ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-sn', '-dn', '-copyts', '-muxdelay', '0', '-muxpreload', '0']
      : ['-map', '0:v:0?', '-map', '0:a:0?', '-map', '0:s?', '-c:v', 'copy', '-c:s', 'copy']),
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-f', 'mpegts', 'pipe:1',
  ];
  const ffmpeg = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`[transcode] started (pid ${ffmpeg.pid})`);

  let stderr = '';
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  let started = false;
  const timeout = setTimeout(() => {
    if (!started) {
      ffmpeg.kill('SIGKILL');
      sendError(res, 504, 'ffmpeg produced no output: the stream may be unreachable');
    }
  }, FIRST_OUTPUT_TIMEOUT_MS);

  ffmpeg.stdout.once('data', (first: Buffer) => {
    started = true;
    clearTimeout(timeout);
    res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' });
    res.write(first);
    ffmpeg.stdout.pipe(res);
  });
  if (vod) {
    const finder = new FirstTimestampFinder((seconds) => recordTranscodeStart(target.href, start, seconds));
    ffmpeg.stdout.on('data', (chunk: Buffer) => finder.push(chunk));
  }

  // Channel switch or tab closed: stop ffmpeg, which also closes its upstream connection.
  res.on('close', () => {
    clearTimeout(timeout);
    ffmpeg.kill('SIGKILL');
  });
  ffmpeg.on('error', (err) => sendError(res, 500, `Could not start ffmpeg: ${err.message}`));
  ffmpeg.on('exit', (code) => {
    clearTimeout(timeout);
    console.log(`[transcode] stopped (pid ${ffmpeg.pid}, exit ${code ?? 'killed'})`);
    if (!started) sendError(res, 502, `ffmpeg failed: ${stderr.trim() || `exit code ${code}`}`);
    else res.end();
  });
}

export function transcodeMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (req.url?.split('?')[0] !== TRANSCODE_PATH) return next();
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
  handle(req, res).catch((err: Error) => sendError(res, 500, `Transcode error: ${err.message}`));
}

export function transcodeService(): Plugin {
  return {
    name: 'ipman-transcode',
    configureServer(server) {
      server.middlewares.use(transcodeMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(transcodeMiddleware);
    },
  };
}
