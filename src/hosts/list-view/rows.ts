// The list view's rows: the listbox, its empty state, row painting, names and selection.

import type { IconSrc, ListView, StartView } from '../../core/protocol/index.ts';
import { hasRow, type RowRef } from '../../core/types.ts';
import { LIST_TEXT } from '../../strings.ts';
import { el, iconOf, reveal, sameRefs, windowName } from './paint.ts';

export interface Rows {
  readonly list: HTMLUListElement;
  readonly empty: HTMLElement;
  start(view: ListView): void;
  icon(w: number, r: number, src: IconSrc | null): void; // the row half of an icon patch
  setMode(mode: StartView['mode']): void; // entering search empties the results
  mode(): StartView['mode'];
  placeWindow(w: number, gone: readonly RowRef[]): void; // window w's rows without the gone ones
  showResults(results: readonly RowRef[], highlight: number): void;
  select(ref: RowRef | null): void;
  picture(): HTMLElement;
  rowAt(target: EventTarget | null): RowRef | null;
  pageRows(): number;
}

const SVG = 'http://www.w3.org/2000/svg';
const PIN = [
  {
    d: 'M10.5 1.5l4 4-1.3 1.3-.8-.4-2.5 2.5.4 3.2L9 13.4l-2.7-2.7-3.6 3.6-1-1 3.6-3.6L2.6 7l1.3-1.3 3.2.4 2.5-2.5-.4-.8z',
  },
];
// A speaker with two waves (C-HOLD-25).
const SOUND = [
  { fill: 'currentColor', d: 'M2 6h2.5L8 3v10L4.5 10H2z' },
  {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
    d: 'M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.5 6.5 0 0 1 0 9',
  },
];

// A clock with a turning back arrow: a recently closed row, in the window marker's place (C-SRCH-27).
const CLOSED = [
  {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    d: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.5M2.5 2.5v3h3M8 5v3l2 1.5',
  },
];

// A row glyph; the row's accessible name already says what it shows.
function glyph(className: string, paths: readonly Record<string, string>[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const attrs of paths) {
    const path = document.createElementNS(SVG, 'path');
    for (const [name, value] of Object.entries(attrs)) path.setAttribute(name, value);
    svg.append(path);
  }
  return svg;
}

// panel takes the none class and the picture; field mirrors the active row; solo says one window is listed.
export function createRows(panel: HTMLElement, field: HTMLInputElement, solo: () => boolean): Rows {
  const list = el('ul', 'list');
  list.id = 'list';
  list.tabIndex = -1;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', LIST_TEXT.tabs);
  const empty = el('div', 'empty');
  empty.setAttribute('role', 'status');

  let windows: ListView['windows'] = [];
  let closed: ListView['closed'] = []; // the closed window, after the listed ones (05-events 4.9)
  let icons: (IconSrc | null)[][] = [];
  let mode: StartView['mode'] = 'hold';
  let results: readonly RowRef[] = [];
  let selected: HTMLElement | null = null;
  const built: HTMLLIElement[][] = [];
  const refs = new WeakMap<Element, RowRef>();

  const isClosed = (ref: RowRef) => ref.window === windows.length;
  const dataOf = (ref: RowRef) => (isClosed(ref) ? closed[ref.row] : windows[ref.window]?.rows[ref.row]);

  // Text first; the icon box is already there, so a late icon moves nothing (C-ICON-04).
  function rowOf(ref: RowRef): HTMLLIElement {
    const { window: w, row: r } = ref;
    const known = built[w]?.[r];
    if (known) return known;
    const data = dataOf(ref) ?? { title: '', site: '', pinned: false, audible: false };
    const li = el('li', 'row');
    li.id = `row-${String(w)}-${String(r)}`;
    li.setAttribute('role', 'option');
    const title = el('span', 'title');
    title.textContent = data.title || data.site || LIST_TEXT.untitled; // as text, never markup (C-SEC-03, C-HOLD-17)
    li.append(iconOf(icons[w]?.[r] ?? null), title);
    if (data.title && data.site) {
      const site = el('span', 'site');
      site.textContent = data.site;
      li.append(site);
    }
    if (data.pinned) li.append(glyph('pin', PIN)); // C-HOLD-16
    if (data.audible) li.append(glyph('sound', SOUND)); // read at the press, never updated (C-HOLD-25)
    if (isClosed(ref)) {
      li.append(glyph('closed', CLOSED));
    } else {
      const marker = el('span', w === 0 ? 'marker current' : 'marker');
      marker.textContent = String(w + 1);
      marker.setAttribute('aria-hidden', 'true');
      li.append(marker);
    }
    (built[w] ??= [])[r] = li;
    refs.set(li, { window: w, row: r });
    return li;
  }

  // The accessible name holds the title, the sound, the pinned state and, in search, the window, or Recently closed
  // for a closed row (C-A11Y-02, C-SRCH-27).
  function place(rows: readonly RowRef[]): void {
    const items = rows.map((ref) => {
      const li = rowOf(ref);
      const data = dataOf(ref);
      const parts = [li.querySelector('.title')?.textContent ?? ''];
      if (data?.audible) parts.push(LIST_TEXT.audible);
      if (data?.pinned) parts.push(LIST_TEXT.pinned);
      if (isClosed(ref)) parts.push(LIST_TEXT.closed);
      else if (mode === 'search' && !solo()) parts.push(windowName(ref.window));
      li.setAttribute('aria-label', LIST_TEXT.rowName(parts));
      return li;
    });
    list.replaceChildren(...items);
    list.scrollTop = 0;
    panel.classList.toggle('none', items.length === 0);
    empty.textContent = items.length === 0 ? LIST_TEXT.noResults : ''; // C-SRCH-16
  }

  function mark(next: HTMLElement | null): void {
    selected?.setAttribute('aria-selected', 'false');
    selected = next;
    if (next) {
      next.setAttribute('aria-selected', 'true');
      list.setAttribute('aria-activedescendant', next.id);
      field.setAttribute('aria-activedescendant', next.id);
      reveal(list, next, true);
    } else {
      list.removeAttribute('aria-activedescendant');
      field.removeAttribute('aria-activedescendant');
    }
  }

  return {
    list,
    empty,
    start(view) {
      ({ windows, closed } = view);
      icons = [...windows, { rows: closed }].map((w) => w.rows.map((r) => r.icon));
    },
    icon(w, r, src) {
      const row = icons[w];
      if (!row) return;
      row[r] = src;
      built[w]?.[r]?.firstElementChild?.replaceWith(iconOf(src));
    },
    setMode(next) {
      mode = next;
      if (next === 'search') results = [];
      list.classList.toggle('search', next === 'search');
    },
    mode: () => mode,
    placeWindow(w, gone) {
      const rows = windows[w]?.rows.map((_, row) => ({ window: w, row })) ?? [];
      place(rows.filter((ref) => !hasRow(gone, ref)));
    },
    showResults(next, highlight) {
      if (!sameRefs(results, next) || list.childElementCount !== results.length) {
        results = next;
        place(results);
      }
      const ref = results[highlight];
      mark(ref ? rowOf(ref) : null);
    },
    select(ref) {
      mark(ref ? rowOf(ref) : null);
    },
    // An inert picture of the shown rows or empty state, outside layout over the live one: no ids, references,
    // selection state or row cache of its own.
    picture() {
      const shown = panel.classList.contains('none') ? empty : list;
      const copy = shown.cloneNode(true) as HTMLElement;
      for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
      copy.removeAttribute('aria-activedescendant');
      copy.removeAttribute('role');
      copy.setAttribute('aria-hidden', 'true');
      copy.inert = true;
      copy.classList.add('copy');
      Object.assign(copy.style, {
        top: `${String(shown.offsetTop)}px`,
        left: `${String(shown.offsetLeft)}px`,
        width: `${String(shown.offsetWidth)}px`,
        height: `${String(shown.offsetHeight)}px`,
      });
      panel.append(copy);
      copy.scrollTop = shown.scrollTop;
      return copy;
    },
    rowAt(target) {
      const row = target instanceof Element ? target.closest('.row') : null;
      return row ? (refs.get(row) ?? null) : null;
    },
    pageRows() {
      const row = list.firstElementChild;
      const pad = parseFloat(getComputedStyle(list).paddingTop);
      return row instanceof HTMLElement && row.offsetHeight > 0
        ? Math.floor((list.clientHeight - 2 * pad) / row.offsetHeight)
        : 1;
    },
  };
}
