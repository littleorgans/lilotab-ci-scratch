// Welcome page: opened once on install; shows the shortcut or how to set one (C-KEY-10, C-KEY-11). Writes nothing.

import '../page.css';
import { SHORTCUT_TEXT, WELCOME_TEXT as T } from '../../strings.ts';
import { SWITCH_COMMAND } from '../../worker/names.ts';
import { el } from '../dom.ts';
import { shortcutBlock, type Shortcut } from '../shortcut.ts';

// How to use the bound shortcut; without a usable one only the toolbar line applies (C-POP-09).
const usage = el('ul', { class: 'usage' });
function showUsage(s: Shortcut): void {
  const lines = s.kind === 'bound' ? [T.tap(s.text), T.hold(s.held, s.text), T.toolbar] : [T.toolbar];
  usage.replaceChildren(...lines.map((line) => el('li', {}, [line])));
}

const settings = el('button', { type: 'button', class: 'link' }, [T.settings]);
settings.addEventListener('click', () => void chrome.runtime.openOptionsPage());

document.title = T.title;
document.body.append(
  el('main', {}, [
    el('h1', {}, [T.title]),
    el('section', { class: 'card' }, [
      shortcutBlock({
        command: SWITCH_COMMAND,
        label: SHORTCUT_TEXT.switchLabel,
        needsModifier: true,
        suggested: true,
        onRead: showUsage,
      }),
    ]),
    usage,
    settings,
  ]),
);
