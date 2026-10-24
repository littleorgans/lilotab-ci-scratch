// Shared DOM renderer for both hosts (03-components 3.3): strip, rows, search field and selection from the start
// view and frames, text before icons, listbox semantics, and the frozen look. Never sends messages or reads keys.

import { QUERY_MAX, type Frame, type IconSrc, type ListView, type StartView } from '../../core/protocol/index.ts';
import type { HostSurface } from '../../core/seams.ts';
import { hasRow, sameRow, type RowRef } from '../../core/types.ts';
import { LIST_TEXT } from '../../strings.ts';
import css from './style.css?inline';

export type Flavor = 'overlay' | 'popup';

export interface ListSurface extends HostSurface {
  readonly element: HTMLElement; // the panel; the host reads row clicks on it
  readonly field: HTMLInputElement;
  readonly list: HTMLUListElement; // the host scrolls this container on wheel input
  latch(): void; // host local switch to search: field in the strip's place, shown, focused (03 4.12)
  unlatch(): void; // host local switch back to hold (T-67): the strip back, the field gone, no highlight
  // Starts the close at once and makes the list inert: a fade on a cancel, else a cut (03 4.12, C-A11Y-04).
  hide(fade: boolean): void;
  focus(): void; // the field in search, else the list (the popup takes focus; the overlay leaves it to the page)
  inField(): boolean;
  rowAt(target: EventTarget | null): RowRef | null;
  pageRows(): number; // the whole rows the list shows (K-32)
  // Copies in the trusted key handler, or says it could not when text is null or the browser refuses (C-SRCH-26).
  copy(text: string | null): void;
}

const SVG = 'http://www.w3.org/2000/svg';
const NOTICE_MS = 2_000; // "Could not copy" (C-SRCH-26)
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

// The one source of list motion (02-contract, List motion): open, cancel close and search swap.
const MOTION = {
  open: 100,
  close: 70,
  swap: 90,
  enter: 'cubic-bezier(0.2, 0, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;
const REDUCE = '(prefers-reduced-motion: reduce)';

// Animations and the cleanup they own. Ending a run applies its final state at once: it cancels what still runs and
// cleans up once, so a superseded run never touches what a later one owns.
interface Run {
  end(): void;
}

let sheet: CSSStyleSheet | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

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

// A data URL image, or the neutral placeholder square for none or one that fails to decode (C-ICON-03).
function iconOf(src: IconSrc | null): HTMLElement {
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
const windowName = (w: number) => (w === 0 ? LIST_TEXT.thisWindow : LIST_TEXT.window(w + 1));

const sameRefs = (a: readonly RowRef[], b: readonly RowRef[]) =>
  a.length === b.length && a.every((r, i) => b[i] !== undefined && sameRow(r, b[i]));

// Keeps child in view by scrolling its container only, never the page (C-HOLD-19).
function reveal(box: HTMLElement, child: HTMLElement, vertical: boolean): void {
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

export function createListSurface(root: Document | ShadowRoot, flavor: Flavor): ListSurface {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  }
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];

  const panel = el('div', `panel ${flavor}`);
  const head = el('div', 'head');
  const strip = el('div', 'strip');
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', LIST_TEXT.windows);
  const list = el('ul', 'list');
  list.id = 'list';
  list.tabIndex = -1;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', LIST_TEXT.tabs);
  const empty = el('div', 'empty');
  empty.setAttribute('role', 'status');
  const notice = el('div', 'notice');
  notice.setAttribute('role', 'status');
  const field = el('input', 'field');
  field.type = 'text';
  field.maxLength = QUERY_MAX;
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.placeholder = LIST_TEXT.search;
  field.setAttribute('role', 'combobox');
  field.setAttribute('aria-label', LIST_TEXT.search);
  field.setAttribute('aria-autocomplete', 'list');
  field.setAttribute('aria-expanded', 'true');
  field.setAttribute('aria-controls', list.id);
  panel.append(list, empty, notice);
  const box = 'body' in root ? root.body : root;

  let windows: ListView['windows'] = [];
  let closed: ListView['closed'] = []; // the closed window, after the listed ones (05-events 4.9)
  let gone: readonly RowRef[] = []; // hidden in hold (C-HOLD-14); search results already omit them
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let icons: (IconSrc | null)[][] = [];
  let mode: StartView['mode'] = 'hold';
  let shownWindow = -1;
  let results: readonly RowRef[] = [];
  let selected: HTMLElement | null = null;
  let cells: HTMLElement[] = [];
  const built: HTMLLIElement[][] = [];
  const refs = new WeakMap<Element, RowRef>();
  let reduceMotion: StartView['look']['reduceMotion'] = 'system';
  const reduced = matchMedia(REDUCE);
  const runs = new Set<Run>();
  let fading: Run | null = null;
  const { promise: removed, resolve: release } = Promise.withResolvers<undefined>(); // the panel is gone

  // Nothing animates when motion is reduced; Never moves whatever the OS asks (C-A11Y-04, C-SET-08).
  const moves = () => reduceMotion === 'never' || (reduceMotion === 'system' && !reduced.matches);
  const settle = () => {
    for (const run of runs) run.end(); // a run deletes itself; Set iteration allows it
  };
  // An OS change to reduce mid motion finishes it at once (C-A11Y-04).
  const onReduce = () => {
    if (!moves()) settle();
  };
  reduced.addEventListener('change', onReduce);

  function animate(animations: readonly Animation[], cleanup: () => void = () => undefined): Run {
    let over = false;
    const run: Run = {
      end() {
        if (over) return;
        over = true;
        runs.delete(run);
        for (const a of animations) a.cancel();
        cleanup();
      },
    };
    runs.add(run);
    Promise.all(animations.map((a) => a.finished)).then(
      () => {
        run.end();
      },
      () => undefined, // cancelled: the run already ended
    );
    return run;
  }

  const swapFade = (node: Element, opacity: [number, number]): Animation =>
    node.animate({ opacity }, { duration: MOTION.swap, easing: MOTION.enter });

  const setRows = (n: number) => {
    panel.style.setProperty('--rows', String(n));
  };
  // Open (02-contract, List motion): the overlay fades and grows about its centre, the popup's window holds still and
  // only its content fades. Later frames never replay it.
  const setShown = (shown: boolean) => {
    const was = panel.classList.contains('shown');
    panel.classList.toggle('shown', shown);
    if (!shown || was || !moves()) return;
    const timing = { duration: MOTION.open, easing: MOTION.enter };
    animate(
      flavor === 'overlay'
        ? [panel.animate({ opacity: [0, 1], transform: ['scale(0.98)', 'none'] }, timing)]
        : [...panel.children].map((child) => child.animate({ opacity: [0, 1] }, timing)),
    );
  };
  const holdRows = () => Math.max(...windows.map((w) => w.rows.length)); // the tallest window (C-WIN-15)
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
    const solo = windows.length === 1;
    const items = rows.map((ref) => {
      const li = rowOf(ref);
      const data = dataOf(ref);
      const parts = [li.querySelector('.title')?.textContent ?? ''];
      if (data?.audible) parts.push(LIST_TEXT.audible);
      if (data?.pinned) parts.push(LIST_TEXT.pinned);
      if (isClosed(ref)) parts.push(LIST_TEXT.closed);
      else if (mode === 'search' && !solo) parts.push(windowName(ref.window));
      li.setAttribute('aria-label', LIST_TEXT.rowName(parts));
      return li;
    });
    list.replaceChildren(...items);
    list.scrollTop = 0;
    panel.classList.toggle('none', items.length === 0);
    empty.textContent = items.length === 0 ? LIST_TEXT.noResults : ''; // C-SRCH-16
  }

  function select(next: HTMLElement | null): void {
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

  // Strip icon: each window's current row (C-WIN-01); the shown window is selected (C-WIN-03, C-A11Y-01).
  function buildStrip(): void {
    cells = windows.map((w, i) => {
      const cell = el('div', 'cell');
      cell.setAttribute('role', 'tab');
      cell.setAttribute('aria-label', windowName(i));
      cell.setAttribute('aria-selected', 'false');
      cell.append(iconOf(icons[i]?.[w.current] ?? null));
      return cell;
    });
    strip.replaceChildren(...cells);
    head.replaceChildren(strip);
    panel.prepend(head);
  }

  // fresh: the gone rows changed, so the shown window's rows are placed again.
  function showWindow(w: number, fresh = false): void {
    if (w === shownWindow && !fresh) return;
    cells[shownWindow]?.setAttribute('aria-selected', 'false');
    shownWindow = w;
    const cell = cells[w];
    if (cell) {
      cell.setAttribute('aria-selected', 'true');
      reveal(strip, cell, false);
    }
    const rows = windows[w]?.rows.map((_, row) => ({ window: w, row })) ?? [];
    place(rows.filter((ref) => !hasRow(gone, ref)));
  }

  // An inert picture of the shown rows or empty state, outside layout over the live one: no ids, references,
  // selection state or row cache of its own.
  function copyRows(): HTMLElement {
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
  }

  // Search swap (02-contract, List motion): strip and field share the head's one grid cell and cross fade, and a copy
  // of the outgoing rows fades out while the live list fades in. A slow worker reply replaces those rows when it
  // arrives; it cannot hold the animation or its cleanup open. next is the head's incoming
  // side, null with one window (C-WIN-10). Instant until the list shows. Only F mode changes swap.
  function swap(next: HTMLElement | null, change: () => void): void {
    settle();
    const moving = moves() && panel.classList.contains('shown');
    const prior = head.isConnected ? head.firstElementChild : null;
    const copy = moving ? copyRows() : null;
    if (next) {
      if (moving) head.append(next);
      else head.replaceChildren(next);
      panel.prepend(head);
    } else if (!moving) head.remove();
    if (copy) {
      const rows = [swapFade(copy, [1, 0]), swapFade(list, [0, 1]), swapFade(empty, [0, 1])];
      const heads = [prior && swapFade(prior, [1, 0]), next && swapFade(next, [0, 1])].filter((a) => a !== null);
      animate([...rows, ...heads], () => {
        copy.remove();
        prior?.remove();
        if (!next) head.remove();
      });
    }
    change();
  }

  function enterSearch(): void {
    swap(field, () => {
      mode = 'search';
      results = [];
      field.value = '';
      list.classList.add('search');
      setRows(windows.reduce((n, w) => n + w.rows.length, 0));
      setShown(true);
      field.focus({ preventScroll: true });
    });
  }

  // The shown window's rows again; the hold frame that follows sets the window and the highlight. The field keeps
  // its text while it fades out; entering search empties it.
  function leaveSearch(): void {
    swap(windows.length > 1 ? strip : null, () => {
      mode = 'hold';
      list.classList.remove('search');
      setRows(holdRows());
      const shown = Math.max(shownWindow, 0);
      shownWindow = -1;
      showWindow(shown);
      select(null);
    });
  }

  function removePanel(): void {
    reduced.removeEventListener('change', onReduce);
    clearTimeout(noticeTimer);
    panel.remove();
    release(undefined);
  }

  function say(text: string): void {
    notice.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice.textContent = '';
    }, NOTICE_MS);
  }

  // Synchronous copy with no clipboard permission (probe p-clip): a temporary textarea inside the root, so page script
  // never sees the text (C-HOLD-20); then focus and selection go back where they were, the page's own in hold.
  function copyText(text: string): boolean {
    const prior = root.activeElement ?? document.activeElement;
    const field = prior instanceof HTMLInputElement || prior instanceof HTMLTextAreaElement ? prior : null;
    const start = field?.selectionStart ?? null;
    const end = field?.selectionEnd ?? null;
    const direction = field?.selectionDirection ?? undefined;
    const area = document.createElement('textarea');
    area.style.cssText = 'position: absolute; top: -100px;';
    area.value = text;
    box.append(area);
    area.focus({ preventScroll: true });
    area.select();
    let ok = false;
    try {
      // oxlint-disable-next-line typescript/no-deprecated -- the one copy route a page's Permissions-Policy cannot block.
      ok = document.execCommand('copy');
    } catch {
      // refused: the caller says so
    }
    area.remove();
    if (prior instanceof HTMLElement) prior.focus({ preventScroll: true });
    if (field && start !== null && end !== null) field.setSelectionRange(start, end, direction);
    return ok;
  }

  // The session paints only frames of the shown mode (05 4.5), so the frame's mode picks the branch.
  function update(frame: Frame): void {
    if (frame.mode === 'hold') {
      const fresh = !sameRefs(gone, frame.gone);
      gone = frame.gone;
      setShown(frame.visible);
      showWindow(frame.window, fresh);
      select(rowOf({ window: frame.window, row: frame.row }));
      return;
    }
    if (!sameRefs(results, frame.results) || list.childElementCount !== results.length) {
      results = frame.results;
      place(results);
    }
    const ref = results[frame.highlight];
    select(ref ? rowOf(ref) : null);
  }

  box.append(panel);

  return {
    element: panel,
    field,
    list,
    start(s) {
      ({ windows, closed } = s.view);
      icons = [...windows, { rows: closed }].map((w) => w.rows.map((r) => r.icon));
      panel.classList.add(s.look.theme);
      if (s.look.textSize === 'large') panel.classList.add('large');
      reduceMotion = s.look.reduceMotion;
      panel.classList.toggle('solo', windows.length === 1);
      setRows(holdRows());
      if (windows.length > 1) buildStrip(); // no strip with one listed window (C-WIN-10)
      if (s.mode === 'search') enterSearch();
      update(s.frame);
    },
    update,
    icons(patch) {
      for (const { w, r, src } of patch) {
        const row = icons[w];
        if (!row) continue;
        row[r] = src;
        built[w]?.[r]?.firstElementChild?.replaceWith(iconOf(src));
        if (windows[w]?.current === r) cells[w]?.firstElementChild?.replaceWith(iconOf(src));
      }
    },
    latch: enterSearch,
    unlatch: leaveSearch,
    // A repeated hide never restarts the fade; a cut ends it at once. Only a shown list fades.
    hide(fade) {
      if (fading) {
        if (!fade) fading.end();
        return;
      }
      const opacity = Number(getComputedStyle(panel).opacity); // from where a cancelled open left it
      panel.inert = true;
      settle();
      if (!fade || !moves() || !panel.classList.contains('shown') || !panel.isConnected) {
        setShown(false);
        return;
      }
      const timing = { duration: MOTION.close, easing: MOTION.exit, fill: 'forwards' } as const;
      fading = animate([panel.animate({ opacity: [opacity, 0] }, timing)], removePanel);
    },
    focus() {
      (mode === 'search' ? field : list).focus({ preventScroll: true });
    },
    inField: () => root.activeElement === field,
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
    copy(text) {
      if (text === null || !copyText(text)) say(LIST_TEXT.notCopied);
    },
    // Waits for a started fade, else removes at once.
    close() {
      if (!fading) {
        settle();
        removePanel();
      }
      return removed;
    },
  };
}
