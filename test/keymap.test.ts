// TB-10 keymap.classify (07-tests 2.1; 04-state-machine 7): what each trusted key or pointer event sends, and
// whether the page may see it.

import { describe, expect, it } from 'vite-plus/test';
import {
  classify,
  queryInput,
  type Classified,
  type HostInput,
  type KeyContext,
  type KeyFacts,
} from '../src/core/index.ts';
import { CMD_E, CTRL_SHIFT_E, binding, keyFacts, pointer } from './host-fixtures.ts';

const HOLD: KeyContext = {
  binding: CMD_E,
  mode: 'hold',
  origin: 'hold',
  open: false,
  field: null,
  mac: true,
  pageRows: 8,
};
const OPEN: KeyContext = { ...HOLD, open: true };
const SEARCH: KeyContext = { ...HOLD, mode: 'search', field: { text: false, selected: false } };
const TOOLBAR: KeyContext = { ...SEARCH, binding: null, origin: 'search' };
const TYPED: KeyContext = { ...SEARCH, field: { text: true, selected: false } };
const ELSEWHERE: KeyContext = { ...SEARCH, binding: CTRL_SHIFT_E, mac: false }; // Windows, Linux, ChromeOS

const cmd = (key: string, over: Partial<KeyFacts> = {}) => keyFacts(key, { meta: true, ...over });

const kept = (input: HostInput | null): Classified => ({ input, swallow: true });
const seen = (input: HostInput | null): Classified => ({ input, swallow: false });

interface Row {
  name: string;
  facts: KeyFacts;
  context: KeyContext;
  expected: Classified;
}

const rows: Row[] = [
  // hold, held key down
  { name: 'K-04 C-KEY-04: Cmd+E steps +1', facts: cmd('e'), context: HOLD, expected: kept({ kind: 'step', delta: 1 }) },
  {
    name: 'K-05 C-KEY-05: Cmd+Shift+E steps -1',
    facts: cmd('E', { shift: true }),
    context: HOLD,
    expected: kept({ kind: 'step', delta: -1 }),
  },
  {
    name: 'K-04 C-WIN-06: held Down moves +1 in the shown list, never a history step',
    facts: cmd('ArrowDown'),
    context: HOLD,
    expected: kept({ kind: 'move', delta: 1 }),
  },
  {
    name: 'K-04 C-KEY-05: Ctrl+Shift+E binding, the shortcut steps +1 and has no Shift form',
    facts: keyFacts('E', { ctrl: true, shift: true }),
    context: { ...HOLD, binding: CTRL_SHIFT_E },
    expected: kept({ kind: 'step', delta: 1 }),
  },
  {
    name: 'K-01 C-KEY-03: Alt+Q binding, Alt keyup releases',
    facts: keyFacts('Alt', { type: 'keyup' }),
    context: { ...HOLD, binding: binding('alt', 'Q') },
    expected: seen({ kind: 'release', inferred: false }),
  },
  {
    name: 'K-04 C-KEY-03: Alt+Q binding, Alt+Q steps although macOS types œ',
    facts: keyFacts('œ', { alt: true, code: 'KeyQ' }),
    context: { ...HOLD, binding: binding('alt', 'Q') },
    expected: kept({ kind: 'step', delta: 1 }),
  },
  {
    name: 'K-02 C-HOLD-10 KB-09: Cmd+Backspace cancels on macOS',
    facts: cmd('Backspace'),
    context: HOLD,
    expected: kept({ kind: 'cancel', cause: 'key' }),
  },
  {
    name: 'K-06 C-KEY-08: Ctrl+Left switches window and is swallowed',
    facts: keyFacts('ArrowLeft', { ctrl: true }),
    context: { ...HOLD, binding: binding('ctrl', 'E') },
    expected: kept({ kind: 'window', delta: -1 }),
  },
  {
    name: 'K-07 C-SRCH-01: held F latches search',
    facts: cmd('f'),
    context: HOLD,
    expected: kept({ kind: 'latchSearch' }),
  },
  {
    name: 'K-08 C-HOLD-13: another held key sends activity and reaches the page',
    facts: cmd('t'),
    context: HOLD,
    expected: seen({ kind: 'activity' }),
  },
  {
    name: 'K-01 C-HOLD-09: held key up releases',
    facts: keyFacts('Meta', { type: 'keyup' }),
    context: HOLD,
    expected: seen({ kind: 'release', inferred: false }),
  },
  // hold, held key missed
  {
    name: 'K-03 C-HOLD-12: another key without the held key is an inferred release',
    facts: keyFacts('ArrowDown'),
    context: HOLD,
    expected: seen({ kind: 'release', inferred: true }),
  },
  {
    name: 'K-03 C-HOLD-12: a pointer move without the held key is an inferred release',
    facts: pointer('pointermove'),
    context: HOLD,
    expected: seen({ kind: 'release', inferred: true }),
  },
  {
    name: 'K-02 KB-07: Esc after a missed release cancels and is swallowed',
    facts: keyFacts('Escape'),
    context: HOLD,
    expected: kept({ kind: 'cancel', cause: 'key' }),
  },
  // open list (planned rows, build spec 5 item 6)
  {
    name: 'K-23 C-TAP-11: open, unheld Down moves',
    facts: keyFacts('ArrowDown'),
    context: OPEN,
    expected: kept({ kind: 'move', delta: 1 }),
  },
  {
    name: 'K-23 C-TAP-11: open, Cmd+E steps +1',
    facts: cmd('e'),
    context: OPEN,
    expected: kept({ kind: 'step', delta: 1 }),
  },
  {
    name: 'K-23 C-KEY-05: open, Cmd+Shift+E steps -1',
    facts: cmd('E', { shift: true }),
    context: OPEN,
    expected: kept({ kind: 'step', delta: -1 }),
  },
  {
    name: 'K-23 C-KEY-05: open, Ctrl+Shift+E binding, the shortcut steps +1',
    facts: keyFacts('E', { ctrl: true, shift: true }),
    context: { ...OPEN, binding: CTRL_SHIFT_E },
    expected: kept({ kind: 'step', delta: 1 }),
  },
  {
    name: 'K-23 K-26: open, Cmd+F binding, the shortcut steps before F latches',
    facts: cmd('f'),
    context: { ...OPEN, binding: binding('meta', 'F') },
    expected: kept({ kind: 'step', delta: 1 }),
  },
  {
    name: 'K-25 C-TAP-11: open, Enter enters',
    facts: keyFacts('Enter'),
    context: OPEN,
    expected: kept({ kind: 'enter' }),
  },
  {
    name: 'K-26 C-TAP-11: open, unheld F latches search',
    facts: keyFacts('f'),
    context: OPEN,
    expected: kept({ kind: 'latchSearch' }),
  },
  {
    name: 'K-26: open, a repeated F sends nothing and is swallowed',
    facts: keyFacts('f', { repeat: true }),
    context: OPEN,
    expected: kept(null),
  },
  {
    name: 'K-29 C-TAP-11: open, Tab sends activity and is swallowed',
    facts: keyFacts('Tab'),
    context: OPEN,
    expected: kept({ kind: 'activity' }),
  },
  {
    name: 'K-28 C-TAP-11: open, held key keyup sends nothing',
    facts: keyFacts('Meta', { type: 'keyup' }),
    context: OPEN,
    expected: seen(null),
  },
  {
    name: 'K-28 C-TAP-11: open, a pointer move sends nothing',
    facts: pointer('pointermove'),
    context: OPEN,
    expected: seen(null),
  },
  {
    name: 'K-28 C-TAP-11: open, a pointer press sends nothing',
    facts: pointer('pointerdown'),
    context: OPEN,
    expected: seen(null),
  },
  // search
  {
    name: 'K-12 C-SRCH-12: search, Cmd+E moves +1 in the results',
    facts: cmd('e'),
    context: SEARCH,
    expected: kept({ kind: 'move', delta: 1 }),
  },
  {
    name: 'K-14 C-SRCH-15: search, Cmd+Backspace edits the field',
    facts: cmd('Backspace'),
    context: SEARCH,
    expected: seen(null),
  },
  {
    name: 'K-18 C-SRCH-13: search, Enter during IME composition sends nothing',
    facts: keyFacts('Enter', { composing: true }),
    context: SEARCH,
    expected: seen(null),
  },
  {
    name: 'K-12 C-POP-09: toolbar search with no binding, Down still moves',
    facts: keyFacts('ArrowDown'),
    context: TOOLBAR,
    expected: kept({ kind: 'move', delta: 1 }),
  },
  {
    name: 'K-22 C-SRCH-20: search, held F in a hold started list leaves search',
    facts: cmd('f'),
    context: SEARCH,
    expected: kept({ kind: 'leaveSearch' }),
  },
  {
    name: 'K-14 C-SRCH-20: search, held F in a search started list sends nothing',
    facts: cmd('f'),
    context: { ...SEARCH, origin: 'search' },
    expected: kept(null),
  },
  {
    name: 'K-14 C-SRCH-20: search, a repeated held F sends nothing',
    facts: cmd('f', { repeat: true }),
    context: SEARCH,
    expected: kept(null),
  },
  // search box keys and list actions (planned rows, settings build)
  {
    name: 'K-11 C-SRCH-14: search, Esc with an empty field cancels',
    facts: keyFacts('Escape'),
    context: SEARCH,
    expected: kept({ kind: 'cancel', cause: 'key' }),
  },
  {
    name: 'K-30 C-SRCH-14: search, Esc with text clears the query',
    facts: keyFacts('Escape'),
    context: TYPED,
    expected: kept({ kind: 'query', text: '' }),
  },
  {
    name: 'K-31 C-SRCH-23: search, Home jumps first',
    facts: keyFacts('Home'),
    context: TYPED,
    expected: kept({ kind: 'jump', to: 'first' }),
  },
  {
    name: 'K-31 C-SRCH-23: search, End jumps last',
    facts: keyFacts('End'),
    context: TYPED,
    expected: kept({ kind: 'jump', to: 'last' }),
  },
  {
    name: 'K-14 C-SRCH-23: search, Shift+Home selects in the field',
    facts: keyFacts('Home', { shift: true }),
    context: TYPED,
    expected: seen(null),
  },
  {
    name: 'K-32 C-SRCH-24: search, Page Down moves by the rows the list shows',
    facts: keyFacts('PageDown'),
    context: SEARCH,
    expected: kept({ kind: 'page', delta: 1, rows: 8 }),
  },
  {
    name: 'K-33 C-SRCH-25: search, macOS Ctrl+Cmd+W closes',
    facts: keyFacts('w', { meta: true, ctrl: true }),
    context: SEARCH,
    expected: kept({ kind: 'close' }),
  },
  {
    name: 'K-33 C-SRCH-25: search, macOS Ctrl+Cmd+Shift+W is no close key',
    facts: keyFacts('W', { meta: true, ctrl: true, shift: true }),
    context: SEARCH,
    expected: seen(null),
  },
  {
    name: 'K-33 C-SRCH-25: search elsewhere, Ctrl+Alt+W producing W closes',
    facts: keyFacts('w', { ctrl: true, alt: true }),
    context: ELSEWHERE,
    expected: kept({ kind: 'close' }),
  },
  {
    name: 'K-33 C-SRCH-25: search elsewhere, Ctrl+Alt+W producing an AltGr character belongs to the field',
    facts: keyFacts('ł', { ctrl: true, alt: true, code: 'KeyW' }),
    context: ELSEWHERE,
    expected: seen(null),
  },
  {
    name: 'K-33 C-HOLD-27: hold, the close key with the held key closes',
    facts: keyFacts('w', { meta: true, ctrl: true }),
    context: HOLD,
    expected: kept({ kind: 'close' }),
  },
  {
    name: 'K-33 K-03: hold with an Alt binding, the close key without the held key is a release',
    facts: keyFacts('w', { meta: true, ctrl: true }),
    context: { ...HOLD, binding: binding('alt', 'Q') },
    expected: seen({ kind: 'release', inferred: true }),
  },
  {
    name: 'K-34 C-HOLD-27: hold, Cmd+C copies the address and sends activity',
    facts: cmd('c'),
    context: HOLD,
    expected: { input: { kind: 'activity' }, swallow: true, copy: 'url' },
  },
  {
    name: 'K-34 C-SRCH-26: search, Shift+Cmd+C copies the title and address, K-20 reports the press',
    facts: cmd('C', { shift: true }),
    context: TYPED,
    expected: { input: null, swallow: true, copy: 'titleUrl' },
  },
  {
    name: 'K-34 C-SRCH-26: search, Ctrl+Shift+Cmd+C copies the title and address',
    facts: keyFacts('C', { meta: true, ctrl: true, shift: true }),
    context: SEARCH,
    expected: { input: null, swallow: true, copy: 'titleUrl' },
  },
  {
    name: 'K-34 C-HOLD-27: hold elsewhere with Alt held, Ctrl+Alt+C copies the address',
    facts: keyFacts('c', { ctrl: true, alt: true }),
    context: { ...HOLD, binding: binding('alt', 'Q'), mac: false },
    expected: { input: { kind: 'activity' }, swallow: true, copy: 'url' },
  },
  {
    name: 'K-34 C-SRCH-26: search elsewhere, Ctrl+Alt+C producing an AltGr character belongs to the field',
    facts: keyFacts('ć', { ctrl: true, alt: true, code: 'KeyC' }),
    context: ELSEWHERE,
    expected: seen(null),
  },
  {
    name: 'K-14 C-SRCH-26: search, Cmd+C with text selected copies it in the field',
    facts: cmd('c'),
    context: { ...SEARCH, field: { text: true, selected: true } },
    expected: seen(null),
  },
  {
    name: 'K-34 K-04: hold, a binding letter C steps before copy',
    facts: cmd('c'),
    context: { ...HOLD, binding: binding('meta', 'C') },
    expected: kept({ kind: 'step', delta: 1 }),
  },
  // untrusted
  ...[HOLD, OPEN, SEARCH].map((context): Row => ({
    name: `K-16 C-SEC-01: ${context.open ? 'open' : context.mode}, an untrusted Esc sends nothing`,
    facts: keyFacts('Escape', { trusted: false }),
    context,
    expected: seen(null),
  })),
];

describe('TB-10 keymap.classify', () => {
  it.each(rows)('$name', ({ facts, context, expected }) => {
    expect(classify(facts, context)).toEqual(expected);
  });

  it('K-09 K-19 C-SRCH-11: composition edits send no query until composition ends', () => {
    expect(queryInput('café', '', true)).toBeNull();
    expect(queryInput('café', '', false)).toEqual({ kind: 'query', text: 'café' });
  });
});
