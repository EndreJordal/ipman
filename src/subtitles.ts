/**
 * Subtitle picker for the player. It lists two kinds of tracks:
 * - the video element's text tracks: HLS WebVTT subtitles and CEA-608/708 captions (rendered
 *   natively by hls.js), plus native tracks in Safari;
 * - DVB bitmap subtitles from raw MPEG-TS streams, decoded by bitmap-subtitles.ts.
 * The button only appears when the current stream has any.
 *
 * Subtitles start off, and this menu is the only thing that turns them on. hls.js auto-shows a
 * playlist's DEFAULT subtitle track and Chrome auto-shows captions tracks, so any text track
 * that starts showing without being chosen here is switched straight back off.
 */
import type { BitmapSubtitles } from './bitmap-subtitles';

const TEXT_KINDS = new Set(['subtitles', 'captions']);

const languageNames = (() => {
  try {
    return new Intl.DisplayNames([navigator.language, 'en'], { type: 'language' });
  } catch {
    return null;
  }
})();

function languageName(code: string): string {
  try {
    return (code && languageNames?.of(code)) || '';
  } catch {
    return ''; // Not a valid language tag.
  }
}

function textTrackLabel(track: TextTrack, index: number): string {
  const label = track.label.trim();
  const language = languageName(track.language);
  let name = label || language || `Track ${index + 1}`;
  if (label && language && label.toLowerCase() !== language.toLowerCase()) name = `${label} (${language})`;
  // Embedded CEA-608/708 captions often share a language with a subtitle track.
  return track.kind === 'captions' ? `${name} (CC)` : name;
}

/** Turns a track off. Captions stay 'hidden' so hls.js keeps collecting cues; subtitles stop loading. */
function turnOff(track: TextTrack): void {
  track.mode = track.kind === 'captions' ? 'hidden' : 'disabled';
}

interface MenuItem {
  label: string;
  checked: boolean;
  choose: () => void;
}

export class SubtitleMenu {
  /** The text track picked in this menu; null when off or when a bitmap track is chosen. */
  private chosen: TextTrack | null = null;
  private items: MenuItem[] = [];

  constructor(
    private video: HTMLVideoElement,
    private button: HTMLButtonElement,
    private menu: HTMLElement,
    private bitmaps: BitmapSubtitles,
  ) {
    const { textTracks } = video;
    for (const type of ['addtrack', 'removetrack', 'change'] as const) {
      textTracks.addEventListener(type, () => this.update());
    }
    bitmaps.onChange(() => this.update());

    button.addEventListener('click', () => {
      if (menu.hidden) this.open();
      else this.close();
    });
    menu.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (!item) return;
      this.items[Number(item.dataset.index)]?.choose();
      this.close();
      // Return focus to the button only for keyboard use (a keyboard "click" has detail 0).
      if (event.detail === 0) button.focus();
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const buttons = [...menu.querySelectorAll<HTMLElement>('.subtitle-item')];
      const i = buttons.indexOf(document.activeElement as HTMLElement);
      buttons[(i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    });
    // Any click outside the button and menu closes it (including opening the ⋮ menu).
    document.addEventListener('click', (event) => {
      const target = event.target as Node;
      if (!button.contains(target) && !menu.contains(target)) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !menu.hidden) {
        this.close();
        button.focus();
      }
    });
    this.update();
  }

  private textTracks(): TextTrack[] {
    return [...this.video.textTracks].filter((t) => TEXT_KINDS.has(t.kind));
  }

  private selectText(track: TextTrack | null): void {
    this.chosen = track;
    for (const t of this.textTracks()) {
      if (t === track) t.mode = 'showing';
      else if (t.mode === 'showing') turnOff(t);
    }
    this.update();
  }

  private buildItems(): MenuItem[] {
    const bitmapSelected = this.bitmaps.selected();
    const off = !this.chosen && !bitmapSelected;
    return [
      {
        label: 'Off',
        checked: off,
        choose: () => {
          this.bitmaps.select(null);
          this.selectText(null);
        },
      },
      ...this.textTracks().map((track, i) => ({
        label: textTrackLabel(track, i),
        checked: track === this.chosen,
        choose: () => {
          this.bitmaps.select(null);
          this.selectText(track);
        },
      })),
      ...this.bitmaps.list().map((track) => ({
        label: `${languageName(track.language) || track.language}${track.hardOfHearing ? ' (hard of hearing)' : ''}`,
        checked: track.id === bitmapSelected,
        choose: () => {
          this.selectText(null);
          this.bitmaps.select(track.id);
        },
      })),
    ];
  }

  private open(): void {
    this.menu.hidden = false;
    this.button.ariaExpanded = 'true';
    this.render();
    this.menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }

  private close(): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.button.ariaExpanded = 'false';
  }

  private update(): void {
    const tracks = this.textTracks();
    // The chosen track is gone after a channel switch; new channels start with subtitles off.
    if (this.chosen && !tracks.includes(this.chosen)) this.chosen = null;
    for (const t of tracks) {
      if (t.mode === 'showing' && t !== this.chosen) turnOff(t);
    }

    const hasTracks = tracks.length > 0 || this.bitmaps.list().length > 0;
    this.button.hidden = !hasTracks;
    this.button.classList.toggle('on', !!this.chosen || !!this.bitmaps.selected());
    if (!hasTracks) this.close();
    else if (!this.menu.hidden) this.render();
  }

  private render(): void {
    this.items = this.buildItems();
    this.menu.replaceChildren(
      ...this.items.map((item, index) => {
        const el = document.createElement('button');
        el.className = 'menu-item subtitle-item';
        el.role = 'menuitemradio';
        el.ariaChecked = String(item.checked);
        el.dataset.index = String(index);
        el.textContent = item.label;
        return el;
      }),
    );
  }
}
