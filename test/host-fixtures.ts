// Shared builders for the host side core tables (07-tests TB-10 to TB-12): key facts, bindings and a start view.

import { DEFAULTS, lookOf, type Binding, type KeyFacts, type ListRow, type StartView } from '../src/core/index.ts';

type Held = Binding['held'];

// A binding whose held key is `held`, with Shift when `shift` is set.
export const binding = (held: Held, key: string, shift = false): Binding => ({
  held,
  mods: { meta: held === 'meta', ctrl: held === 'ctrl', alt: held === 'alt', shift },
  key,
});

export const CMD_E = binding('meta', 'E'); // macOS default
export const CTRL_SHIFT_E = binding('ctrl', 'E', true);

const CODES: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Meta: 'MetaLeft',
  Control: 'ControlLeft',
  Alt: 'AltLeft',
};

// A trusted keydown with no modifiers; `key` alone also sets a matching `code` for letters and named keys.
export function keyFacts(key: string, over: Partial<KeyFacts> = {}): KeyFacts {
  const code = CODES[key] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key);
  return {
    type: 'keydown',
    key,
    code,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    trusted: true,
    composing: false,
    repeat: false,
    ...over,
  };
}

export const pointer = (type: 'pointermove' | 'pointerdown', over: Partial<KeyFacts> = {}): KeyFacts =>
  keyFacts('', { type, code: '', ...over });

export const row = (title: string, over: Partial<ListRow> = {}): ListRow => ({
  title,
  site: 'example.com',
  pinned: false,
  audible: false,
  icon: null,
  ...over,
});

// One window of three rows, the source tab at row 0, the cursor on the source, Cmd+E bound.
export const startView = (over: Partial<StartView> = {}): StartView => ({
  mode: 'hold',
  binding: CMD_E,
  quickTap: 'flip',
  look: lookOf(DEFAULTS),
  view: { windows: [{ current: 0, rows: [row('Source'), row('Second'), row('Third')] }], closed: [] },
  frame: { mode: 'hold', visible: true, open: false, window: 0, row: 0, gone: [], copy: null },
  ...over,
});
