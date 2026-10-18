/**
 * Version display and update notice in the settings dialog. The server does the actual check
 * against GitHub (server/version.ts), and only when "Check for updates" is on.
 */
import { store } from './store';

interface VersionInfo {
  version: string;
  /** Installed with install.ps1 (as opposed to running from a project checkout). */
  packaged: boolean;
  latest: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  /** When the server last asked GitHub (null: not yet), and why that failed. */
  checkedAt: number | null;
  checkError: string | null;
  installCommand: string;
}

/** The server asks GitHub at most once an hour; asking the server more often costs nothing. */
const RECHECK_MS = 15 * 60 * 1000;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initUpdates(settingsButton: HTMLElement): void {
  const els = {
    version: byId('app-version'),
    checkUpdates: byId<HTMLInputElement>('check-updates'),
    notice: byId('update-notice'),
    title: byId('update-title'),
    how: byId('update-how'),
    command: byId('update-command'),
    copy: byId<HTMLButtonElement>('copy-command'),
    releaseLink: byId<HTMLAnchorElement>('release-link'),
    skip: byId<HTMLButtonElement>('skip-version'),
    checkNow: byId<HTMLButtonElement>('check-now'),
    checkResult: byId('check-result'),
  };
  let info: VersionInfo | null = null;
  /** "Check now" was used: show what it found, even with update checks off. */
  let checkedNow = false;

  const render = () => {
    els.version.textContent = info ? `ipman ${info.version}${info.packaged ? '' : ' (dev)'}` : '';
    // A checkout is always the newest code: nothing to check.
    els.checkNow.hidden = !info?.packaged;
    els.checkUpdates.checked = store.getCheckUpdates();
    const show = !!info?.updateAvailable && (store.getCheckUpdates() || checkedNow) && info.latest !== store.getSkippedVersion();
    els.notice.hidden = !show;
    settingsButton.classList.toggle('has-update', show);
    settingsButton.title = show ? 'Settings: an update is available' : 'Settings';
    if (!show || !info) return;
    els.title.textContent = `ipman ${info.latest} is available (you have ${info.version}).`;
    // The server only reports updates for installed copies; source checkouts are always current.
    els.how.textContent = 'To update, run this in PowerShell. Your settings and favorites are kept.';
    els.command.textContent = info.installCommand;
    els.releaseLink.hidden = !info.releaseUrl;
    if (info.releaseUrl) els.releaseLink.href = info.releaseUrl;
  };

  /** `now`: the "Check now" link, which asks GitHub right away, whatever the setting. */
  const check = async (now = false) => {
    try {
      const res = await fetch(`/version${now ? '?check=now' : store.getCheckUpdates() ? '?check=1' : ''}`);
      if (res.ok) info = (await res.json()) as VersionInfo;
    } catch {
      // Server restarting; try again next round.
    }
    render();
  };

  els.checkUpdates.addEventListener('change', () => {
    store.setCheckUpdates(els.checkUpdates.checked);
    void check();
  });
  els.checkNow.addEventListener('click', async () => {
    els.checkNow.disabled = true;
    els.checkNow.textContent = 'Checking…';
    els.checkResult.textContent = '';
    const before = info;
    checkedNow = true;
    await check(true);
    els.checkNow.disabled = false;
    els.checkNow.textContent = 'Check now';
    if (!info || info === before) els.checkResult.textContent = 'Could not reach the ipman server.';
    else if (info.checkError) els.checkResult.textContent = `Could not check: ${info.checkError}`;
    else if (!info.updateAvailable) els.checkResult.textContent = 'Up to date.';
    // The notice shows a new version, unless it was skipped.
    else if (info.latest === store.getSkippedVersion()) els.checkResult.textContent = `ipman ${info.latest} is available (skipped).`;
  });
  els.copy.addEventListener('click', () => {
    if (!info) return;
    void navigator.clipboard.writeText(info.installCommand).then(() => {
      els.copy.textContent = 'Copied';
      setTimeout(() => (els.copy.textContent = 'Copy'), 2000);
    });
  });
  els.skip.addEventListener('click', () => {
    if (info?.latest) store.setSkippedVersion(info.latest);
    render();
  });

  void check();
  setInterval(() => void check(), RECHECK_MS);
}
