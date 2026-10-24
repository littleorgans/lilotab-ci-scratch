// Keys in the list: the fixed list keys, read only, with this platform's modifier names (C-SET-21, C-SRCH-25,
// C-SRCH-26).

import { isMac } from '../../browser/platform.ts';
import { KEYS_TEXT as T, KEY_NAMES } from '../../strings.ts';
import { el, hint, row } from '../dom.ts';

export function keysRow(): HTMLElement {
  const mac = isMac();
  const mod = mac ? KEY_NAMES.meta : KEY_NAMES.ctrl;
  // Chrome keeps Ctrl+W off macOS, so the close key there is Ctrl+Alt+W (C-SRCH-25).
  const close = [KEY_NAMES.ctrl, mac ? KEY_NAMES.meta : KEY_NAMES.alt, 'W'].join('+');
  const keys = T.keys(mod, close).flatMap(([k, action]) => [el('dt', {}, [k]), el('dd', {}, [action])]);
  return row(T.label, [hint(T.hint(mod)), el('dl', { class: 'keys' }, keys)]);
}
