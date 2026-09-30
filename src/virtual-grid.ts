import { updateChildren } from './virtual-list';

/**
 * A virtual grid of equally sized cards: only the rows in view (plus a small overscan) exist in
 * the DOM, so a catalogue of tens of thousands of movies scrolls smoothly. Columns follow the
 * available width; cards keep a fixed aspect ratio plus room for text below.
 */
export interface GridOptions {
  /** Narrowest a card may get before a column is dropped. */
  minCardWidth: number;
  gap: number;
  /** Card height = width * aspect + extraHeight (for the text under the poster). */
  aspect: number;
  extraHeight: number;
  overscanRows?: number;
}

export class VirtualGrid<T> {
  private items: T[] = [];
  private rendered = new Map<number, HTMLElement>();
  private spacer = document.createElement('div');
  private frame = 0;
  private columns = 1;
  private cardWidth = 0;
  private rowHeight = 0;
  private lastWidth = -1;
  /** A refresh arrived while hidden. */
  private stale = false;

  constructor(
    private root: HTMLElement,
    private renderCard: (item: T, index: number) => HTMLElement,
    private options: GridOptions,
  ) {
    this.spacer.className = 'vgrid-spacer';
    root.append(this.spacer);
    root.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(root);
  }

  setItems(items: T[]): void {
    this.items = items;
    this.refresh();
  }

  /** Re-renders visible cards, e.g. after their data changed. */
  refresh(): void {
    this.render(true);
  }

  scrollToTop(): void {
    this.root.scrollTop = 0;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Returns true when the card size or columns changed. */
  private layout(): boolean {
    const { minCardWidth, gap, aspect, extraHeight } = this.options;
    const style = getComputedStyle(this.root);
    const width = this.root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (width === this.lastWidth) return false;
    this.lastWidth = width;
    this.columns = Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)));
    this.cardWidth = (width - gap * (this.columns - 1)) / this.columns;
    this.rowHeight = this.cardWidth * aspect + extraHeight + gap;
    return true; // positions changed
  }

  private render(rebuild = false): void {
    if (!this.root.clientWidth) {
      if (rebuild) this.stale = true; // hidden: rebuild once it shows again
      return;
    }
    if (this.stale) {
      rebuild = true;
      this.stale = false;
    }
    if (this.layout()) rebuild = true;
    const { gap, overscanRows = 2 } = this.options;
    const rows = Math.ceil(this.items.length / this.columns);
    this.spacer.style.height = `${Math.max(0, rows * this.rowHeight - gap)}px`;

    const { scrollTop, clientHeight } = this.root;
    const first = Math.max(0, Math.floor(scrollTop / this.rowHeight) - overscanRows);
    const last = Math.min(rows, Math.ceil((scrollTop + clientHeight) / this.rowHeight) + overscanRows);

    // Reuse cards that stay in view so their posters don't reload while scrolling.
    const next = new Map<number, HTMLElement>();
    for (let row = first; row < last; row++) {
      for (let col = 0; col < this.columns; col++) {
        const index = row * this.columns + col;
        if (index >= this.items.length) break;
        let card = rebuild ? undefined : this.rendered.get(index);
        if (!card) {
          card = this.renderCard(this.items[index], index);
          card.dataset.index = String(index);
          Object.assign(card.style, {
            width: `${this.cardWidth}px`,
            transform: `translate(${col * (this.cardWidth + gap)}px, ${row * this.rowHeight}px)`,
          });
        }
        next.set(index, card);
      }
    }
    updateChildren(this.spacer, this.rendered, next);
    this.rendered = next;
  }
}
