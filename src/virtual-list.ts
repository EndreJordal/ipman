/**
 * Fixed-row-height virtual list: only the rows in view (plus a small overscan) exist in the DOM,
 * so playlists with tens of thousands of channels scroll smoothly.
 */
/**
 * Puts `next` in the spacer, touching only what changed: rebuilding every child would take the
 * keyboard focus away from a focused card or button. After a refresh, which re-creates the nodes,
 * focus moves to the new node at the same position.
 */
export function updateChildren(spacer: HTMLElement, previous: Map<number, HTMLElement>, next: Map<number, HTMLElement>): void {
  const active = document.activeElement;
  let focusedIndex = -1;
  for (const [index, node] of previous) {
    if (next.get(index) === node) continue;
    if (active && node.contains(active)) focusedIndex = index;
    node.remove();
  }
  for (const node of next.values()) if (node.parentNode !== spacer) spacer.append(node);
  const replacement = next.get(focusedIndex);
  if (replacement && !replacement.contains(document.activeElement)) replacement.focus({ preventScroll: true });
}

export class VirtualList<T> {
  private items: T[] = [];
  private rendered = new Map<number, HTMLElement>();
  private spacer = document.createElement('div');
  private frame = 0;

  constructor(
    private root: HTMLElement,
    private rowHeight: number,
    private renderRow: (item: T, index: number) => HTMLElement,
    private overscan = 8,
  ) {
    this.spacer.className = 'vlist-spacer';
    root.append(this.spacer);
    root.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(root);
  }

  setItems(items: T[]): void {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    this.refresh();
  }

  /** Re-renders visible rows, e.g. after the active or favorite state changed. */
  refresh(): void {
    this.render(true);
  }

  scrollToIndex(index: number): void {
    const top = index * this.rowHeight;
    const bottom = top + this.rowHeight;
    if (top < this.root.scrollTop) this.root.scrollTop = top;
    else if (bottom > this.root.scrollTop + this.root.clientHeight) this.root.scrollTop = bottom - this.root.clientHeight;
    this.render();
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

  private render(rebuild = false): void {
    const { scrollTop, clientHeight } = this.root;
    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.overscan);
    const end = Math.min(this.items.length, Math.ceil((scrollTop + clientHeight) / this.rowHeight) + this.overscan);

    // Reuse rows that stay in view so their logos don't reload while scrolling.
    const next = new Map<number, HTMLElement>();
    for (let i = start; i < end; i++) {
      let row = rebuild ? undefined : this.rendered.get(i);
      if (!row) {
        row = this.renderRow(this.items[i], i);
        row.dataset.index = String(i);
        row.style.transform = `translateY(${i * this.rowHeight}px)`;
      }
      next.set(i, row);
    }
    updateChildren(this.spacer, this.rendered, next);
    this.rendered = next;
  }
}
