// One host session on one channel, the same for both hosts after `start` (03-components 3.3): parse worker messages,
// paint through the list view, run the five sensors through the core host input rules (04-state-machine 7) and send
// what they mean. Holds only host local state (03 4.12); the worker's disconnect is the close (05-events 4.4).

import { isMac } from '../../browser/platform.ts';
import {
  FIELD_EVENTS,
  hostInputStep,
  initialHostInputState,
  type FieldEvent,
  type HostEffect,
  type HostEvent,
  type HostResume,
} from '../../core/host-input/index.ts';
import type { KeyFacts } from '../../core/keymap/index.ts';
import {
  PING_MS,
  type DeclineReason,
  type HostInput,
  type HostMode,
  type HostToWorker,
  type StartView,
} from '../../core/protocol/index.ts';
import type { ListSurface } from '../list-view/index.ts';

// What a host page adds around the shared session.
export interface Host {
  alive(): boolean; // this instance's extension context still works (05 5); every callback checks it first
  dispose(): void; // a dead instance lets go of everything and lets the event through
  decline(): DeclineReason | null; // checked on start; the overlay may refuse (05 4.6), the popup never does
  mount(mode: HostMode): Mounted; // the start view's mode: an overlay started in search marks itself as latch does
  focused(): Promise<void>; // the popup posts ready only once it has focus (05 3.3)
  closed(): void; // after the session ends
}

export interface Mounted {
  surface: ListSurface;
  owns(e: Event): boolean; // the event happened inside the list, so the page must not see it
  latch(): void; // to search (03 4.12): the surface takes focus in the field, and the host may mark itself for it
  // Back to hold (T-67): the surface leaves search and focus goes where hold keeps it (03 4.12), the list when open.
  unlatch(open: boolean): void;
  // Starts the close at once on an input that ends a hold or on the session's end: focus goes back to the page first,
  // then the list fades or cuts (03 4.12, C-A11Y-04).
  hide(fade: boolean): void;
  remove(): void; // after hide: the DOM goes once the surface has closed
}

export interface Session {
  // Ends the session with a cut and disconnects: a new session or orphan disposal, so a retiring list never covers
  // the next one (03 4.12).
  end(): void;
}

type Sensed = KeyFacts['type'];
const SENSED: readonly Sensed[] = ['keydown', 'keyup', 'pointermove', 'pointerdown'];

// The event's own facts; the core adds the composition it remembers.
function factsOf(e: Event, type: Sensed): KeyFacts | null {
  if (!(e instanceof KeyboardEvent) && !(e instanceof PointerEvent)) return null;
  const key = e instanceof KeyboardEvent ? e : null;
  return {
    type,
    key: key?.key ?? '',
    code: key?.code ?? '',
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    trusted: e.isTrusted,
    composing: key?.isComposing ?? false,
    repeat: key?.repeat ?? false,
  };
}

const fieldValue = (m: Mounted): string | null => (m.surface.inField() ? m.surface.field.value : null);
const fieldSelected = ({ surface: { field } }: Mounted): boolean => field.selectionStart !== field.selectionEnd;

export function runSession(port: chrome.runtime.Port, host: Host): Session {
  let state = initialHostInputState(isMac()); // the session (03 4.12, 05 4.5), its binding and the sensors' memory
  let mounted: Mounted | null = null;
  let done = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  let moving = false; // the host is moving focus itself (latch, unlatch, open): its blurs are not leaving (K-15)
  const listeners: (() => void)[] = [];

  function post(m: HostToWorker): void {
    try {
      port.postMessage(m);
    } catch {
      end(); // the worker is gone and its disconnect never came (05 6, R1b)
    }
  }

  // Sensors, ping and the port stop at once; only the DOM waits for a close fade (03 4.12, C-SW-02). Idempotent; a
  // cut also ends a fade still running.
  function end(disconnect = true, ending = state.session?.ending ?? 'fade'): void {
    if (done) {
      if (ending === 'cut') mounted?.hide(false);
      return;
    }
    done = true;
    clearInterval(ping);
    for (const off of listeners) off();
    if (disconnect) {
      try {
        port.disconnect();
      } catch {
        // already gone
      }
    }
    mounted?.hide(ending === 'fade');
    mounted?.remove();
    host.closed();
  }

  // Every callback checks its own instance first; a dead one disposes itself and leaves the event alone (05 5).
  const live = () => {
    if (host.alive()) return !done;
    host.dispose();
    return false;
  };

  // Search and the open list keep focus and clicks; leaving them cancels (K-15).
  const latched = () => state.session?.mode === 'search' || (state.session?.open ?? false);

  function on(target: EventTarget, type: string, fn: (e: Event) => void): void {
    const listener = (e: Event) => {
      if (live() && e.isTrusted) fn(e); // untrusted events mean nothing (K-16, C-SEC-01)
    };
    target.addEventListener(type, listener, { capture: true });
    listeners.push(() => {
      target.removeEventListener(type, listener, { capture: true });
    });
  }

  // The core decides switches, hiding, admission and what the page may see; effects run in its order, so a local
  // switch and its focus come before its post (03 4.12). The state is set first: a sensor that fires during an effect
  // reads the new mode. A resume goes on with the state as those effects left it, within the same event.
  function dispatch(event: HostEvent, original?: Event): void {
    let next: HostEvent | HostResume | null = event;
    while (next !== null) {
      const result = hostInputStep(state, next);
      state = result.state;
      for (const effect of result.effects) perform(effect, original);
      next = result.resume;
    }
  }

  function perform(effect: HostEffect, original: Event | undefined): void {
    switch (effect.kind) {
      case 'start':
        begin(effect.start).catch(() => {
          end(); // could not paint: the worker sees the disconnect (05 4.4)
        });
        break;
      case 'paint':
        mounted?.surface.update(effect.frame);
        break;
      case 'icons':
        mounted?.surface.icons(effect.icons);
        break;
      // Held F: focus the field at once, so keys typed before the worker answers land in it (03 4.12).
      case 'latch':
        moveFocus(() => mounted?.latch());
        startPing();
        break;
      // Held F in search: back to hold, so the next keys mean hold keys (T-67, K-22). The open list keeps its ping and
      // focus (C-TAP-11).
      case 'unlatch':
        if (!state.session?.open) {
          clearInterval(ping);
          ping = undefined;
        }
        moveFocus(() => mounted?.unlatch(state.session?.open ?? false));
        break;
      // The open list holds focus and keeps the worker awake like search (T-68, K-17, C-SW-03).
      case 'open':
        moveFocus(() => mounted?.surface.focus());
        startPing();
        break;
      case 'hide':
        mounted?.hide(effect.fade);
        break;
      case 'post':
        post({ t: 'input', input: effect.input });
        break;
      case 'end':
        end(); // a message this host cannot admit ends its session (05 4.5)
        break;
      case 'consume':
        if (effect.preventDefault) original?.preventDefault();
        if (effect.stopImmediatePropagation) original?.stopImmediatePropagation();
        break;
      // Esc with text: no input event fires, and the query '' follows (K-30).
      case 'clearField':
        if (mounted) mounted.surface.field.value = '';
        break;
      // In the trusted key handler; the copy's own focus moves are not leaving (K-15, K-34).
      case 'copy':
        moveFocus(() => mounted?.surface.copy(effect.text));
        break;
    }
  }

  function moveFocus(change: () => void): void {
    moving = true;
    try {
      change();
    } finally {
      moving = false;
    }
    // A page focus trap can redirect the move and blur the list while moving is true. Check after focus settles and
    // this step posts its input, so that real loss still cancels in channel order (K-15).
    queueMicrotask(() => {
      if (live() && latched() && mounted && !mounted.surface.element.matches(':focus-within')) leave('blur');
    });
  }

  function send(input: HostInput): void {
    dispatch({ kind: 'send', input });
  }

  // K-17: every 20 s while the search list or the open list is visible and its document focused.
  function startPing(): void {
    ping ??= setInterval(() => {
      if (live() && document.visibilityState === 'visible' && document.hasFocus())
        post({ t: 'input', input: { kind: 'ping' } });
    }, PING_MS);
  }

  // Keys and pointer (K-01 to K-08, K-10 to K-12, K-14, K-18, K-20).
  function onSensed(e: Event, type: Sensed, m: Mounted): void {
    const facts = factsOf(e, type);
    if (!facts) return;
    dispatch(
      {
        kind: 'sensed',
        facts,
        // oxlint-disable-next-line typescript/no-deprecated -- IME code 229 can arrive with isComposing false.
        keyCode: e instanceof KeyboardEvent ? e.keyCode : null,
        fieldValue: fieldValue(m),
        fieldSelected: fieldSelected(m),
        pageRows: type === 'keydown' ? m.surface.pageRows() : 1, // a layout read only where a page key can be
        owned: m.owns(e),
      },
      e,
    );
  }

  // Field (K-09, K-19).
  function onField(e: Event, type: FieldEvent, m: Mounted): void {
    dispatch(
      {
        kind: 'field',
        type,
        trusted: e.isTrusted,
        fieldValue: fieldValue(m),
        inputComposing: e instanceof InputEvent ? e.isComposing : null,
        owned: m.owns(e),
      },
      e,
    );
  }

  // Row click in search or the open list (K-13, K-21): click is the authoritative row event, so moving off the row
  // before release picks nothing.
  function onClick(e: Event): void {
    if (!latched() || !(e instanceof MouseEvent) || e.button !== 0 || !mounted) return;
    const row = mounted.surface.rowAt(e.target);
    if (row) e.preventDefault();
    send(row ? { kind: 'pick', row } : { kind: 'activity' });
  }

  // Leaving (K-15).
  function leave(cause: 'blur' | 'hidden' | 'pageLeave'): void {
    if (!state.session?.quiet) send({ kind: 'cancel', cause });
  }

  function listen(m: Mounted): void {
    for (const type of SENSED) {
      on(window, type, (e) => {
        onSensed(e, type, m);
      });
    }
    for (const type of FIELD_EVENTS) {
      on(window, type, (e) => {
        onField(e, type, m);
      });
    }
    on(m.surface.element, 'click', onClick);
    // These local UI events share the sensors' trust and orphan checks (05 5, K-16).
    on(m.surface.element, 'wheel', (e) => {
      if (state.session?.quiet || !(e instanceof WheelEvent)) return;
      e.preventDefault();
      m.surface.list.scrollTop += e.deltaY; // scroll only the list, even at its end (C-HOLD-19)
    });
    on(m.surface.element, 'mousedown', (e) => {
      if (!state.session?.quiet && e.target !== m.surface.field) e.preventDefault(); // keep typing in the field (C-SRCH-05)
    });
    // The window's own blur; capture also sees element blur. In search or the open list, the field or list losing
    // focus is the list losing it too (K-15): keyboard extensions such as Vimium take Esc in insert mode by blurring
    // the field. The host's own focus moves are not.
    on(window, 'blur', (e) => {
      if (e.target === e.currentTarget || (latched() && !moving && m.owns(e))) leave('blur');
    });
    // In search or the open list a press on the page takes focus from the list, as a popup does (C-SRCH-05).
    on(window, 'pointerdown', (e) => {
      if (latched() && !m.owns(e)) leave('blur');
    });
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') leave('hidden');
    });
    on(window, 'pagehide', () => {
      leave('pageLeave');
    });
  }

  async function begin(s: StartView): Promise<void> {
    const reason = host.decline();
    if (reason) {
      post({ t: 'declined', reason }); // dormant: the worker retires the attempt and disconnects
      return;
    }
    mounted = host.mount(s.mode);
    mounted.surface.start(s); // the start frame is painted before ready
    await host.focused();
    if (done) return;
    listen(mounted);
    if (latched()) startPing();
    post({ t: 'ready' }); // ready means the listeners are installed (03 3.3)
  }

  port.onMessage.addListener((raw) => {
    if (live()) dispatch({ kind: 'message', raw });
  });
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      // read, so Chrome logs no unchecked error; the disconnect itself is the close
    }
    end(false);
  });

  return {
    end() {
      end(true, 'cut');
    },
  };
}
