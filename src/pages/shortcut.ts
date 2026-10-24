// The shortcut row both pages show for a command: the bound shortcut or "No shortcut set" on one line with where to
// set it, plus "needs Cmd, Ctrl or Alt" when the switch command lacks one, a note on a missing or clashing default,
// and "Change shortcut" (C-SET-01, C-SET-20, C-KEY-09, C-KEY-10, C-KEY-11, C-KEY-13). Read again whenever the page
// becomes visible (05 3.3).

import { readShortcut } from '../browser/commands.ts';
import { isMac } from '../browser/platform.ts';
import { MODIFIERS, keyText, parseBinding, type Binding } from '../core/index.ts';
import { KEY_NAMES, SHORTCUT_TEXT } from '../strings.ts';
import { el, hint, row } from './dom.ts';

const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts'; // C-SET-17: a page cannot link it, tabs.create can open it

export type Shortcut =
  | { kind: 'bound'; text: string; held: string }
  | { kind: 'none' }
  | { kind: 'noModifier'; text: string }; // the browser's own string, which parseBinding refuses

// Contract form, primary modifier first: "Cmd+E", "Ctrl+Shift+E", "Alt+Q" (C-KEY-01 to C-KEY-03).
function bindingText(b: Binding): string {
  const mods = MODIFIERS.filter((m) => b.mods[m]).map((m) => KEY_NAMES[m]);
  return [...mods, keyText(b.key)].join('+');
}

async function readState(command: string): Promise<Shortcut> {
  const shortcut = (await readShortcut(command)).trim();
  if (!shortcut) return { kind: 'none' };
  const binding = parseBinding(shortcut);
  if (!binding) return { kind: 'noModifier', text: shortcut };
  return { kind: 'bound', text: bindingText(binding), held: KEY_NAMES[binding.held] };
}

export interface ShortcutBlock {
  command: string;
  label: string;
  needsModifier: boolean; // the switch command needs a held key (C-KEY-11); a search command does not (C-KEY-12)
  suggested: boolean; // the switch command has a suggested key the notes explain (C-KEY-09, C-KEY-13); search has none
  onRead?: (s: Shortcut) => void; // lets a page add copy for the state it shows
}

// Mounts the block and keeps it current.
export function shortcutBlock({ command, label, needsModifier, suggested, onRead }: ShortcutBlock): HTMLElement {
  const value = el('span');
  const problem = el('p', { class: 'problem' });
  const note = hint('');
  const mac = isMac();
  const change = el('button', { type: 'button' }, [SHORTCUT_TEXT.change]);
  change.addEventListener('click', () => {
    void chrome.tabs.create({ url: SHORTCUTS_PAGE });
  });

  async function refresh(): Promise<void> {
    // A failed read happens only while the browser shuts down; the block keeps what it showed.
    const s = await readState(command).catch(() => null);
    if (!s) return;
    value.replaceChildren(s.kind === 'none' ? SHORTCUT_TEXT.none : el('kbd', {}, [s.text]), ' · ');
    value.hidden = false;
    const refused = needsModifier && s.kind === 'noModifier';
    problem.textContent = refused ? SHORTCUT_TEXT.noModifier : '';
    problem.hidden = !refused;
    // The default may be taken when unbound (C-KEY-09); on macOS, Opera and Vivaldi may keep Command+E (C-KEY-13).
    const notes = {
      none: SHORTCUT_TEXT.taken,
      bound: mac ? SHORTCUT_TEXT.macForks : '',
      noModifier: '',
    } satisfies Record<Shortcut['kind'], string>;
    note.textContent = suggested ? notes[s.kind] : '';
    note.hidden = !note.textContent;
    onRead?.(s);
  }
  value.hidden = problem.hidden = note.hidden = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  void refresh();

  return row(label, [el('p', { class: 'hint' }, [value, SHORTCUT_TEXT.where]), problem, note], change);
}
