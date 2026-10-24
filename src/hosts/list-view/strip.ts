// The window strip: one cell per listed window, and the shown one selected.

import type { IconSrc, ListView } from '../../core/protocol/index.ts';
import { LIST_TEXT } from '../../strings.ts';
import { el, iconOf, reveal, windowName } from './paint.ts';

export interface Strip {
  readonly element: HTMLElement;
  build(windows: ListView['windows']): void;
  fill(listed: (w: number) => boolean): void; // keeps the cells of the windows that still list a row
  solo(): boolean; // one listed window: no strip (C-WIN-10)
  show(w: number): void;
  icon(w: number, r: number, src: IconSrc | null): void; // the cell half of an icon patch
}

export function createStrip(): Strip {
  const element = el('div', 'strip');
  element.setAttribute('role', 'tablist');
  element.setAttribute('aria-label', LIST_TEXT.windows);

  let cells: HTMLElement[] = [];
  let currents: number[] = [];
  let shown = -1;

  return {
    element,
    // Strip icon: each window's current row (C-WIN-01).
    build(windows) {
      currents = windows.map((w) => w.current);
      cells = windows.map((w, i) => {
        const cell = el('div', 'cell');
        cell.setAttribute('role', 'tab');
        cell.setAttribute('aria-label', windowName(i));
        cell.setAttribute('aria-selected', 'false');
        cell.append(iconOf(w.rows[w.current]?.icon ?? null));
        return cell;
      });
      element.replaceChildren(...cells);
    },
    // A window whose rows were all closed with the close key leaves the strip (C-WIN-01, T-24).
    fill(listed) {
      element.replaceChildren(...cells.filter((_, w) => listed(w)));
    },
    solo: () => element.childElementCount < 2,
    // The shown window is selected (C-WIN-03, C-A11Y-01).
    show(w) {
      cells[shown]?.setAttribute('aria-selected', 'false');
      shown = w;
      const cell = cells[w];
      if (cell) {
        cell.setAttribute('aria-selected', 'true');
        reveal(element, cell, false);
      }
    },
    icon(w, r, src) {
      if (currents[w] === r) cells[w]?.firstElementChild?.replaceWith(iconOf(src));
    },
  };
}
