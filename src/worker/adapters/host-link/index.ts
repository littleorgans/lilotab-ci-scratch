// Worker half of both hosts: launch, attempt registry and channels (03-components 3.2, 05-events 4.2 to 4.4).

import { clearOwnedPopup } from '../../../browser/action-popup.ts';
import {
  admit,
  parseHostToWorker,
  parsePortName,
  portName,
  type AttemptId,
  type ChannelPhase,
  type CoreEvent,
  type HostLink,
  type HostStatus,
  type Millis,
  type Sink,
  type StartView,
} from '../../../core/index.ts';
import { reportCode } from '../../diagnostics.ts';
import { clock } from '../clock/index.ts';
import { POPUP_PAGE } from '../../names.ts';
import { timing } from '../../timing/index.ts';

interface Attempt {
  host: 'overlay' | 'popup';
  tabId: number;
  start: StartView;
  dwell: Millis | null; // the dwell due, overlay only: a visible popup page keeps the worker's timer on time
  phase: ChannelPhase;
  port: chrome.runtime.Port | null;
}

// A channel that ends or breaks the protocol: failed for an overlay before its handshake (fall back, T-08), else
// closed (cancel, T-20, T-30, T-44) (05 4.4).
const endStatus = (a: Attempt): HostStatus => (a.host === 'overlay' && a.phase !== 'open' ? 'failed' : 'closed');

// Sender is this extension, no tab, and exactly the popup page whose hash names the port's attempt (05 4.3).
// Compared as strings: getURL gives the extension origin and path on every URL parser.
const fromPopupPage = (sender: chrome.runtime.MessageSender | undefined, attempt: AttemptId): boolean =>
  sender?.id === chrome.runtime.id &&
  sender.tab === undefined &&
  sender.url === `${chrome.runtime.getURL(POPUP_PAGE)}#${attempt}`;

export function createHostLink(overlayFile: string): HostLink {
  const live = new Map<AttemptId, Attempt>(); // registered attempts; a retired one is gone, so it stays silent
  let sink: Sink | null = null;

  const status = (attempt: AttemptId, s: HostStatus) => {
    sink?.((at) => (live.has(attempt) ? { kind: 'hostStatus', at, attempt, status: s } : null));
  };

  // Unregister and close the channel: the worker's disconnect is the host's close (05 4.4).
  function retire(attempt: AttemptId, a: Attempt): void {
    live.delete(attempt);
    a.port?.disconnect();
    if (a.host === 'popup') clearPopup(a.tabId, attempt);
  }

  // A host disconnect or violation retires the attempt here, then reports it by host and phase.
  function end(attempt: AttemptId, a: Attempt, at: Millis): CoreEvent {
    retire(attempt, a);
    return { kind: 'hostStatus', at, attempt, status: endStatus(a) };
  }

  // Parsed inside prepare, so a violation is ordered with everything else (05 2.1); the attempt comes from the port.
  function onMessage(attempt: AttemptId, port: chrome.runtime.Port, raw: unknown, at: Millis): CoreEvent | null {
    const a = live.get(attempt);
    if (a?.port !== port) return null;
    const m = parseHostToWorker(raw);
    const phase = m ? admit(a.host, a.phase, m) : 'violation';
    if (!m || phase === 'violation') {
      reportCode('protocolViolation', m?.t ?? 'shape');
      return end(attempt, a, at);
    }
    a.phase = phase;
    if (m.t === 'input') return { kind: 'host', at, attempt, input: m.input };
    if (m.t === 'declined') {
      reportCode('hostDeclined', m.reason);
      timing?.declined(attempt, m.reason);
    }
    return { kind: 'hostStatus', at, attempt, status: m.t === 'ready' ? 'ready' : 'declined' };
  }

  // Binds a port to its attempt and sends the start view as the channel's first message. The wake is the time left to
  // the dwell due as it posts, so injection time counts (05-events 2.3, 4.5).
  function open(attempt: AttemptId, a: Attempt, port: chrome.runtime.Port): void {
    a.port = port;
    port.onMessage.addListener((raw) => {
      sink?.((at) => onMessage(attempt, port, raw, at));
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        // read, so Chrome logs no unchecked error; the cause is the host's, reported by phase below
      }
      sink?.((at) => {
        const now = live.get(attempt);
        return now?.port === port ? end(attempt, now, at) : null;
      });
    });
    const wake = a.dwell === null ? null : Math.max(0, a.dwell - clock.now());
    port.postMessage({ t: 'start', start: a.start, wake });
  }

  function clearPopup(tabId: number, attempt: AttemptId): void {
    clearOwnedPopup(tabId, attempt).catch(() => undefined); // the tab may have closed
  }

  // 05 4.3: every check passes, else the port is refused and the popup closes on disconnect.
  function acceptPopup(port: chrome.runtime.Port): void {
    const attempt = parsePortName(port.name);
    const a = attempt === null ? undefined : live.get(attempt);
    if (attempt === null || a?.host !== 'popup' || a.port !== null || !fromPopupPage(port.sender, attempt)) {
      reportCode('portRefused', a ? 'sender' : 'attempt');
      port.disconnect();
      return;
    }
    open(attempt, a, port);
  }

  // 05 4.2: inject the self contained overlay file into frame 0, then connect to that very document. Rejected, or
  // no frame 0 result with a documentId: failed.
  async function inject(attempt: AttemptId, tabId: number): Promise<void> {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: [overlayFile],
      world: 'ISOLATED',
      injectImmediately: true,
    });
    timing?.launched(attempt);
    const a = live.get(attempt);
    if (!a) return; // retired meanwhile: the injected script stays dormant
    const documentId = results.find((r) => r.frameId === 0)?.documentId;
    if (!documentId) throw new Error('no document');
    open(attempt, a, chrome.tabs.connect(tabId, { documentId, name: portName(attempt) }));
  }

  // 05 4.3: set the tab's popup to this attempt, open it, then clear it, so a later click reaches onClicked.
  async function launchPopup(attempt: AttemptId, tabId: number, windowId: number): Promise<void> {
    try {
      await chrome.action.setPopup({ tabId, popup: `${POPUP_PAGE}#${attempt}` });
      if (live.has(attempt)) {
        await chrome.action.openPopup({ windowId });
        timing?.launched(attempt);
      }
    } finally {
      clearPopup(tabId, attempt);
    }
  }

  return {
    mountOverlay(attempt, tabId, start, dwell) {
      live.set(attempt, { host: 'overlay', tabId, start, dwell, phase: 'opening', port: null });
      inject(attempt, tabId).catch(() => {
        status(attempt, 'failed');
      });
    },
    openPopup(attempt, tabId, windowId, start) {
      live.set(attempt, { host: 'popup', tabId, start, dwell: null, phase: 'opening', port: null });
      launchPopup(attempt, tabId, windowId).catch(() => {
        status(attempt, 'failed');
      });
    },
    send(attempt, msg) {
      try {
        live.get(attempt)?.port?.postMessage(msg);
      } catch {
        // the host went away; its disconnect reports it
      }
    },
    close(attempt) {
      const a = live.get(attempt);
      if (a) retire(attempt, a);
    },
    onEvent(s) {
      sink = s;
      chrome.runtime.onConnect.addListener(acceptPopup);
    },
  };
}
