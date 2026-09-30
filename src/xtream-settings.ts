/**
 * The "Xtream account" section of the settings dialog. It shows the account detected from the
 * playlist, lets the user override it (field by field), and tests the connection: on demand, and
 * automatically when the dialog opens.
 */
import { fetchAccountInfo, isComplete, normalizeServer, XtreamError, type XtreamAccount, type XtreamAccountInfo } from './lib/xtream';

const WARN_DAYS = 7;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function describe(info: XtreamAccountInfo): { text: string; tone: 'ok' | 'warn' } {
  const parts = ['✓ Connected'];
  if (info.status) parts.push(`subscription ${info.status.toLowerCase()}${info.isTrial ? ' (trial)' : ''}`);
  let tone: 'ok' | 'warn' = 'ok';
  if (info.expiresAt) {
    const days = Math.floor((info.expiresAt - Date.now()) / 86_400_000);
    const date = new Date(info.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    parts.push(days >= 0 ? `expires ${date} (in ${days === 0 ? 'less than a day' : `${days} day${days === 1 ? '' : 's'}`})` : `expired ${date}`);
    if (days < WARN_DAYS) tone = 'warn';
  } else {
    parts.push('no end date');
  }
  if (info.maxConnections) parts.push(`${info.activeConnections} of ${info.maxConnections} connection${info.maxConnections === 1 ? '' : 's'} in use`);
  return { text: parts.join(' · '), tone };
}

export class XtreamSettings {
  private detected: XtreamAccount | null = null;
  private testRun = 0;
  private els = {
    detected: byId('xtream-detected'),
    server: byId<HTMLInputElement>('xtream-server'),
    username: byId<HTMLInputElement>('xtream-username'),
    password: byId<HTMLInputElement>('xtream-password'),
    show: byId<HTMLButtonElement>('xtream-show'),
    test: byId<HTMLButtonElement>('xtream-test'),
    status: byId('xtream-status'),
  };

  /** @param fetchUrl turns an upstream URL into one the browser can fetch (the local proxy). */
  constructor(private fetchUrl: (url: string) => string) {
    const { show, password, test } = this.els;
    show.addEventListener('click', () => {
      const hidden = password.type === 'password';
      password.type = hidden ? 'text' : 'password';
      show.textContent = hidden ? 'Hide' : 'Show';
      show.ariaLabel = hidden ? 'Hide password' : 'Show password';
    });
    test.addEventListener('click', () => void this.test());
    for (const input of [this.els.server, this.els.username, password]) {
      // Edited: a test still running is for the old values, so its answer no longer applies.
      input.addEventListener('input', () => {
        this.testRun++;
        this.setStatus('', 'muted');
      });
    }
  }

  /** Fills the section as the settings dialog opens, and checks the account right away. */
  open(saved: XtreamAccount, detected: XtreamAccount | null): void {
    const { server, username, password, show } = this.els;
    this.detected = detected;
    server.value = saved.server;
    username.value = saved.username;
    password.value = saved.password;
    password.type = 'password';
    show.textContent = 'Show';
    server.placeholder = detected?.server ?? 'http://server:8080';
    username.placeholder = detected?.username ?? '';
    password.placeholder = detected ? 'from playlist' : '';
    this.els.detected.textContent = detected
      ? `Detected from your playlist: ${detected.server}, user ${detected.username}. Leave the fields empty to use it.`
      : 'No Xtream account found in your playlist. If your provider has one, enter it here.';
    this.setStatus('', 'muted');
    if (this.effective()) void this.test();
  }

  /** What to save: only what the user typed. Empty fields fall back to the detected account. */
  value(): XtreamAccount {
    return { server: normalizeServer(this.els.server.value), username: this.els.username.value.trim(), password: this.els.password.value };
  }

  /** The account in use: typed fields override the detected ones. Null if incomplete. */
  effective(): XtreamAccount | null {
    return effectiveAccount(this.value(), this.detected);
  }

  private async test(): Promise<void> {
    const run = ++this.testRun;
    const account = this.effective();
    if (!account) return this.setStatus('Enter the server, username and password first.', 'muted');
    this.setStatus('Testing…', 'muted');
    try {
      const { text, tone } = describe(await fetchAccountInfo(account, this.fetchUrl));
      if (run === this.testRun) this.setStatus(text, tone);
    } catch (err) {
      if (run !== this.testRun) return;
      this.setStatus(`✗ ${err instanceof XtreamError ? err.message : 'The test failed.'}`, 'error');
    }
  }

  private setStatus(text: string, tone: 'ok' | 'warn' | 'error' | 'muted'): void {
    this.els.status.textContent = text;
    this.els.status.dataset.tone = tone;
  }
}

/** Typed fields override the detected account, field by field. Null if the result is incomplete. */
export function effectiveAccount(saved: XtreamAccount, detected: XtreamAccount | null): XtreamAccount | null {
  const account = {
    server: saved.server || detected?.server || '',
    username: saved.username || detected?.username || '',
    password: saved.password || detected?.password || '',
  };
  return isComplete(account) ? account : null;
}
