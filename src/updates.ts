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
  installCommand: string;
}

/** The server caches GitHub's answer for 12 hours; asking it more often costs nothing. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initUpdates(settingsButton: HTMLElement): void {
  const els = {
    version: byId('app-version'),
    checkUpdates: byId<HTMLInputElement>('check-updates'),
    notice: byId('update-notice'),
    title: byId('update-title'),
    how: byId('update-how'),
    commandRow: byId('update-command-row'),
    command: byId('update-command'),
    copy: byId<HTMLButtonElement>('copy-command'),
    releaseLink: byId<HTMLAnchorElement>('release-link'),
    skip: byId<HTMLButtonElement>('skip-version'),
  };
  let info: VersionInfo | null = null;

  const render = () => {
    els.version.textContent = info ? `ipman ${info.version}` : '';
    els.checkUpdates.checked = store.getCheckUpdates();
    const show = !!info?.updateAvailable && store.getCheckUpdates() && info.latest !== store.getSkippedVersion();
    els.notice.hidden = !show;
    settingsButton.classList.toggle('has-update', show);
    settingsButton.title = show ? 'Settings: an update is available' : 'Settings';
    if (!show || !info) return;
    els.title.textContent = `ipman ${info.latest} is available (you have ${info.version}).`;
    if (info.packaged) {
      els.how.textContent = 'To update, run this in PowerShell. Your settings and favorites are kept.';
      els.command.textContent = info.installCommand;
      els.commandRow.hidden = false;
    } else {
      els.how.textContent = 'You are running ipman from source: update with git pull.';
      els.commandRow.hidden = true;
    }
    els.releaseLink.hidden = !info.releaseUrl;
    if (info.releaseUrl) els.releaseLink.href = info.releaseUrl;
  };

  const check = async () => {
    try {
      const res = await fetch(`/version${store.getCheckUpdates() ? '?check=1' : ''}`);
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
