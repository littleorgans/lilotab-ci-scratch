// Gesture timing log on the options page, measurement builds only: the recording switch, a summary, recent gestures,
// Export and Clear. Its text and style stay here, so release builds carry none of it.

import {
  TIMING_KEY,
  TIMING_MAX,
  TIMING_OFF_KEY,
  onTimingChanged,
  readTiming,
  type GestureRecord,
  type TimingState,
  type TimingRecord,
} from '../../browser/timing.ts';
import { PRODUCT } from '../../strings.ts';
import { el, group, hint, row } from '../dom.ts';

const RECENT = 30; // table rows, newest first

const TEXT = {
  heading: 'Gesture timing',
  record: 'Record gesture timing',
  kept: `Kept in this browser only: the last ${String(TIMING_MAX)} gestures, never addresses or titles.`,
  on: 'On',
  off: 'Off',
  log: 'Log',
  export: 'Export',
  clear: 'Clear',
  empty: 'No gestures yet.',
  columns: ['Time', 'Host', 'Page', 'Delay', 'Ready', 'Input', 'Dwell', 'Shown', 'Outcome'],
} as const;

export const TIMING_HEADING = TEXT.heading; // the ninth group, after About and in the side index

const STYLE = `
.timing-rows { display: block; overflow-x: auto; padding: 8px 10px; }
.timing-rows table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; white-space: nowrap; }
.timing-rows th, .timing-rows td { padding: 3px 6px; text-align: right; }
.timing-rows th { color: var(--muted); font-weight: 500; }
.timing-rows :is(th, td):is(:nth-child(-n + 3), :last-child) { text-align: left; }
.timing-rows tr + tr td { border-top: 1px solid var(--line); }
.timing-actions { display: flex; gap: 8px; }
`;

const hostOf = (r: GestureRecord) => r.attempts.at(-1)?.host ?? 'overlay';

// The list showed and its host sent nothing before the gesture ended, a missed release (C-HOLD-12, T-32); or nothing
// before a further shortcut press, which is either a retry after a missed release or a hold that steps.
const untilPress = (r: GestureRecord) =>
  r.unheardPress ??
  (r.shown !== null && r.pressAt !== null && r.pressAt >= r.shown && (r.input === null || r.pressAt < r.input.at));
const untilEnd = (r: GestureRecord) => r.shown !== null && r.outcome === 'cancel' && r.input === null && !untilPress(r);

function summary(all: readonly TimingRecord[]): string {
  const records = all.filter((r): r is GestureRecord => r.outcome !== 'dropped');
  const count = (keep: (r: GestureRecord) => boolean) => String(records.filter(keep).length);
  const unheard = (r: GestureRecord) => untilEnd(r) || untilPress(r);
  const by = (host: string) => count((r) => unheard(r) && hostOf(r) === host);
  return (
    `${count(() => true)} gestures, ${count((r) => r.shown !== null)} lists shown, ${count(unheard)} with no ` +
    `host input before cancel or next press (overlay ${by('overlay')}, popup ${by('popup')}): ${count(untilEnd)} ` +
    `until the end, ${count(untilPress)} until a further press. ${count((r) => r.input?.inferred === true)} ` +
    `inferred releases. ${String(all.length - records.length)} preparation timeouts.`
  );
}

const ms = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(Math.round(n)));

function cells(r: TimingRecord): string[] {
  if (r.outcome === 'dropped') {
    return [new Date(r.epoch).toLocaleTimeString(), '', '', '', '', '', '', '', `${r.outcome} ${r.reason}`];
  }
  return [
    new Date(r.epoch).toLocaleTimeString(),
    r.attempts.map((a) => a.host).join(' > '),
    r.page,
    ms(r.dwellDue),
    ms(r.attempts.at(-1)?.ready),
    r.input ? `${ms(r.input.at)} ${r.input.inferred ? 'inferred' : r.input.input}` : '',
    ms(r.dwell),
    ms(r.shown),
    `${r.outcome} ${r.reason}`,
  ];
}

function table(records: readonly TimingRecord[]): HTMLElement {
  if (records.length === 0) return el('p', { class: 'hint' }, [TEXT.empty]);
  const head = el(
    'tr',
    {},
    TEXT.columns.map((c) => el('th', {}, [c])),
  );
  const rows = records
    .slice(-RECENT)
    .reverse()
    .map((r) =>
      el(
        'tr',
        {},
        cells(r).map((c) => el('td', {}, [c])),
      ),
    );
  return el('table', {}, [el('thead', {}, [head]), el('tbody', {}, rows)]);
}

function download(records: readonly TimingRecord[]): void {
  const data = { product: PRODUCT, version: chrome.runtime.getManifest().version, exported: Date.now(), records };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  el('a', { href: url, download: `${PRODUCT.toLowerCase()}-timing-${stamp}.json` }).click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

function switchControl(set: (on: boolean) => void): { node: HTMLElement; show: (on: boolean) => void } {
  const inputs = [true, false].map((value) => {
    const input = el('input', { type: 'radio', name: 'timing', value: String(value) });
    input.addEventListener('change', () => {
      set(value);
    });
    return input;
  });
  const options = inputs.map((input, n) => el('label', { class: 'option' }, [input, n === 0 ? TEXT.on : TEXT.off]));
  const node = el('fieldset', { 'aria-labelledby': 'label-timing' }, [el('div', { class: 'track' }, options)]);
  return {
    node,
    show(on) {
      for (const input of inputs) input.checked = input.value === String(on);
    },
  };
}

export function timingGroup(): HTMLElement {
  let state: TimingState = { on: true, records: [] };
  const toggle = switchControl((on) => {
    const write = on
      ? chrome.storage.local.remove(TIMING_OFF_KEY)
      : chrome.storage.local.set({ [TIMING_OFF_KEY]: true });
    void write.catch(() => undefined);
  });
  const status = el('p', { class: 'hint' });
  const recent = el('div', { class: 'row timing-rows' });
  const exportButton = el('button', { type: 'button' }, [TEXT.export]);
  const clear = el('button', { type: 'button' }, [TEXT.clear]);
  exportButton.addEventListener('click', () => {
    download(state.records);
  });
  clear.addEventListener('click', () => {
    void chrome.storage.local.remove(TIMING_KEY).catch(() => undefined);
  });

  function render(): void {
    toggle.show(state.on);
    status.textContent = summary(state.records);
    recent.replaceChildren(table(state.records));
  }
  function refresh(): void {
    void readTiming().then((next) => {
      state = next;
      render();
    });
  }
  onTimingChanged(refresh);
  refresh();

  document.head.append(el('style', {}, [STYLE]));
  return group(
    TEXT.heading,
    [
      row(TEXT.record, [hint(TEXT.kept)], toggle.node, 'label-timing'),
      row(TEXT.log, [status], el('div', { class: 'timing-actions' }, [exportButton, clear])),
      recent,
    ],
    'timing',
  );
}
