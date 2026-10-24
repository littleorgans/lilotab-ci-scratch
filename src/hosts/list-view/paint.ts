// Painting helpers the list view's parts share; no state of their own.

import type { IconSrc } from '../../core/protocol/index.ts';
import { sameRow, type RowRef } from '../../core/types.ts';
import { LIST_TEXT } from '../../strings.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

// A data URL image, or the neutral placeholder square for none or one that fails to decode (C-ICON-03).
export function iconOf(src: IconSrc | null): HTMLElement {
  const placeholder = () => el('span', 'icon');
  if (src === null) return placeholder();
  const img = el('img', 'icon');
  img.alt = '';
  img.addEventListener(
    'error',
    () => {
      img.replaceWith(placeholder());
    },
    { once: true },
  );
  img.src = src;
  return img;
}

// The source window is window 0 (05-events 4.9).
export const windowName = (w: number) => (w === 0 ? LIST_TEXT.thisWindow : LIST_TEXT.window(w + 1));

export const sameRefs = (a: readonly RowRef[], b: readonly RowRef[]) =>
  a.length === b.length && a.every((r, i) => b[i] !== undefined && sameRow(r, b[i]));

// Keeps child in view by scrolling its container only, never the page (C-HOLD-19).
export function reveal(box: HTMLElement, child: HTMLElement, vertical: boolean): void {
  const [start, size, scroll, view] = vertical
    ? [child.offsetTop, child.offsetHeight, box.scrollTop, box.clientHeight]
    : [child.offsetLeft, child.offsetWidth, box.scrollLeft, box.clientWidth];
  const pad = vertical ? parseFloat(getComputedStyle(box).paddingTop) : 0;
  let next = scroll;
  if (start - pad < scroll) next = start - pad;
  else if (start + size + pad > scroll + view) next = start + size + pad - view;
  if (vertical) box.scrollTop = next;
  else box.scrollLeft = next;
}
