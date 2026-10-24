// Keys in the list: the fixed list keys, read only, with this platform's modifier names (C-SET-21, C-SRCH-25,
// C-SRCH-26).

import { isMac } from '../../browser/platform.ts';
import { KEYS_TEXT as T, KEY_NAMES } from '../../strings.ts';
import { el, hint, row } from '../dom.ts';
import type { Shortcut } from '../shortcut.ts';

// onRead names the bound shortcut's held key in the hint; until then, and without one, the platform default's
// (C-KEY-01 to C-KEY-03).
export function keysRow(): { row: HTMLElement; onRead: (s: Shortcut) => void } {
  const mac = isMac();
  const mod = mac ? KEY_NAMES.meta : KEY_NAMES.ctrl;
  // Chrome keeps Ctrl+W off macOS, so the close key there is Ctrl+Alt+W; the copy keys take the same chord (C-SRCH-25).
  const chord = [KEY_NAMES.ctrl, mac ? KEY_NAMES.meta : KEY_NAMES.alt].join('+');
  const held = mac ? KEY_NAMES.meta : KEY_NAMES.alt;
  const note = hint(T.hint(held));
  const keys = T.keys(mod, chord).flatMap(([k, action]) => [el('dt', {}, [k]), el('dd', {}, [action])]);
  return {
    row: row(T.label, [note, el('dl', { class: 'keys' }, keys)]),
    onRead: (s) => {
      note.textContent = T.hint(s.kind === 'bound' ? s.held : held);
    },
  };
}
