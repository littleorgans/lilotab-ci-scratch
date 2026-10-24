// Overlay host: the self contained file the host link injects into frame 0 (03-components 3.3, 05-events 4.2, 5).
// On evaluation it registers one runtime.onConnect listener per isolated world and does nothing else.

import { parsePortName, type DeclineReason, type HostMode } from '../../core/protocol/index.ts';
import { createListSurface } from '../list-view/index.ts';
import { runSession, type Host, type Mounted, type Session } from '../session/index.ts';

interface Guard {
  alive(): boolean;
  dispose(): void;
}

// The symbol registry belongs to this isolated world, so page script can neither see nor forge the guard (05 5). The
// world is this extension's alone, so a fixed neutral key holds across injections, updates and renames.
const GUARD = Symbol.for('overlay.guard');
const FOCUS_TAKERS = ['iframe', 'frame', 'embed', 'object'];

// Over every page style: inline and important, in the top layer above dialogs and fullscreen elements (C-HOLD-18).
const HOST_STYLE = [
  'all: initial',
  'position: fixed',
  'inset: 0',
  'width: 100vw',
  'height: 100vh',
  'max-width: none',
  'max-height: none',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'background: transparent',
  'display: flex',
  'align-items: center',
  'justify-content: center',
  'overflow: visible',
  'pointer-events: none',
  'z-index: 2147483647',
]
  .map((rule) => `${rule} !important;`)
  .join(' ');

// The start checks (05 4.6): the list needs a focused HTML document with a top layer and the page's own focus.
function declineReason(): DeclineReason | null {
  if (document.contentType === 'application/pdf') return 'pdf';
  if (!(document.documentElement instanceof HTMLElement) || !('showPopover' in HTMLElement.prototype)) {
    return 'unsupported';
  }
  if (!document.hasFocus()) return 'unfocused';
  return FOCUS_TAKERS.includes(document.activeElement?.localName ?? '') ? 'frameFocus' : null;
}

// Keyboard extensions cannot see the field inside the closed root, only the host as the focused element. Marked
// editable while the field is, they leave typing to it; plaintext-only allows no rich edits on the host itself.
const editable = (host: HTMLElement) => {
  host.contentEditable = 'plaintext-only';
};

// A closed shadow root keeps titles from page script (C-HOLD-20); a div cannot be upgraded by a page's custom element.
// A search start (the Search tabs command, C-KEY-12) is editable from the first paint, which focuses the field.
function mountOverlay(mode: HostMode): Mounted {
  const prior = document.activeElement;
  const host = document.createElement('div');
  host.setAttribute('popover', 'manual');
  host.style.cssText = HOST_STYLE;
  if (mode === 'search') editable(host);
  const root = host.attachShadow({ mode: 'closed' });
  const surface = createListSurface(root, 'overlay');
  let tookFocus = false;
  host.addEventListener('focusin', () => {
    tookFocus = true;
  });
  document.documentElement.append(host);
  host.showPopover();
  // A fullscreen element entered later would cover the list; showing again puts it back on top.
  const raise = () => {
    if (!host.matches(':popover-open')) return;
    host.hidePopover();
    host.showPopover();
  };
  document.addEventListener('fullscreenchange', raise);
  // The field or the open list took focus from the page; it goes back when they go, unless the open list keeps it
  // (03 4.12, T-67). Dropping contenteditable clears focus, so the list takes it after the change.
  const giveBack = (change: () => void, keep = false) => {
    const focused = root.activeElement !== null;
    host.removeAttribute('contenteditable');
    change();
    if (keep) surface.list.focus({ preventScroll: true });
    else if (focused && prior instanceof HTMLElement) prior.focus({ preventScroll: true });
    // A blur already cleared the root. A click into a frame or a page's own focus call may still be moving focus, so
    // wait for this task to finish and return focus only when it went nowhere (K-15).
    else if (tookFocus && prior instanceof HTMLElement) {
      setTimeout(() => {
        if (document.activeElement === document.body) prior.focus({ preventScroll: true });
      });
    }
  };
  return {
    surface,
    owns: (e) => e.composedPath().includes(host), // the closed root shows outside listeners only its host
    latch() {
      editable(host);
      surface.latch();
    },
    unlatch(open) {
      giveBack(() => {
        surface.unlatch();
      }, open);
    },
    // Focus is checked before the list turns inert, and goes back at the start of the close (03 4.12).
    hide(fade) {
      giveBack(() => {
        surface.hide(fade);
      });
    },
    remove() {
      document.removeEventListener('fullscreenchange', raise);
      void surface.close().then(() => {
        host.remove();
      });
    },
  };
}

function install(): void {
  const scope = globalThis as unknown as Record<symbol, Guard | undefined>;
  const prior = scope[GUARD];
  if (prior?.alive()) return; // evaluated again by the same instance at the next press: keep its listener
  try {
    prior?.dispose(); // an orphan from before an update or reload shares this world
  } catch {
    // its runtime is dead
  }

  const runtime = chrome.runtime; // captured, so alive reads this instance's context
  let session: Session | null = null;

  const alive = (): boolean => {
    try {
      return Boolean(runtime.id);
    } catch {
      return false;
    }
  };

  function dispose(): void {
    try {
      runtime.onConnect.removeListener(onConnect);
    } catch {
      // its runtime is dead
    }
    session?.end();
    session = null;
    if (scope[GUARD] === guard) scope[GUARD] = undefined;
  }

  const host: Host = {
    alive,
    dispose,
    decline: declineReason,
    mount: mountOverlay,
    focused: () => Promise.resolve(),
    closed: () => undefined,
  };

  // Only this extension's worker, which has no tab and the extension origin, on this protocol (05 4.2). Whether a
  // worker opened port carries origin or url is unverified (05 10); when both are absent the first two checks stand.
  function accepts(port: chrome.runtime.Port): boolean {
    const sender = port.sender;
    if (!alive() || sender?.id !== runtime.id || sender.tab !== undefined) return false;
    const extension = runtime.getURL('').slice(0, -1); // the extension origin, compared as a string
    const url = sender.url;
    const origin = sender.origin ?? (url?.startsWith(`${extension}/`) ? extension : url);
    return (origin === undefined || origin === extension) && parsePortName(port.name) !== null;
  }

  function onConnect(port: chrome.runtime.Port): void {
    if (!alive()) {
      dispose();
      return;
    }
    if (!accepts(port)) {
      port.disconnect();
      return;
    }
    session?.end(); // a new session ends any earlier one in this document
    session = runSession(port, host);
  }

  const guard: Guard = { alive, dispose };
  runtime.onConnect.addListener(onConnect);
  scope[GUARD] = guard;
}

install();
