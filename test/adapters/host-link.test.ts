// Host link: popup port checks, late popups, channels ending before ready and the overlay's dwell wake, against a fake
// chrome (07-tests 2.2, AC-10, AC-12; 05-events 2.3, 4.2 to 4.4).

import { beforeEach, expect, test, vi } from 'vite-plus/test';
import { portName, type Millis } from '../../src/core/index.ts';
import type { ListSurface } from '../../src/hosts/list-view/index.ts';
import { runSession } from '../../src/hosts/session/index.ts';
import { registerEntry } from '../../src/worker/adapters/entry/index.ts';
import { createHostLink } from '../../src/worker/adapters/host-link/index.ts';
import { createTabs } from '../../src/worker/adapters/tabs/index.ts';
import { startView } from '../host-fixtures.ts';
import {
  collect,
  createPort,
  extensionUrl,
  installFakeChrome,
  noClosed,
  popupUrl,
  settle,
  sleep,
  type FakeBrowser,
  type FakePort,
} from './fake-chrome.ts';

const A = 'boot2:1:1'; // the live attempt
const START = startView();

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeChrome();
});

// The host link with entry, so a toolbar click steps; the attempt launches its host on tab 11 in window 1.
function launch(host: 'overlay' | 'popup', dwell: Millis | null = null) {
  const { ingress, stepped } = collect();
  const hostLink = createHostLink('overlay.js');
  hostLink.onEvent(ingress);
  registerEntry(ingress, () => createTabs().liveFacts(), noClosed);
  if (host === 'overlay') hostLink.mountOverlay(A, 11, START, dwell);
  else hostLink.openPopup(A, 11, 1, START);
  return { hostLink, stepped };
}

let resolveGate = (): void => undefined;
const holdGate = (call: 'action.setPopup' | 'action.openPopup') => {
  browser.gates[call] = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
};

// C-SEC-02, C-SW-02: each check of 05-events 4.3; a refused port is closed at once and never gets the start view.
test.each<{ name: string; connect: (b: FakeBrowser) => FakePort }>([
  {
    name: 'from another page',
    connect: (b) => b.connect(portName(A), `${extensionUrl('src/pages/options/index.html')}#${A}`),
  },
  { name: 'whose page names a wrong attempt', connect: (b) => b.connect(portName(A), popupUrl('boot2:1:2')) },
  { name: 'from an older boot', connect: (b) => b.connect(portName('boot1:1:1'), popupUrl('boot1:1:1')) },
  {
    name: 'that is the second for one attempt',
    connect: (b) => {
      const first = b.connect(portName(A), popupUrl(A));
      expect(first).toMatchObject({ disconnected: false, posted: [{ t: 'start' }] });
      return b.connect(portName(A), popupUrl(A));
    },
  },
])('AC-10 hostLink.popupPort: a port $name is refused and the popup closes', async ({ connect }) => {
  launch('popup');
  await settle();
  expect(connect(browser)).toMatchObject({ disconnected: true, posted: [] });
});

// C-POP-11, C-POP-09, KB-10: once the gesture ends, the tab's popup is cleared, so the next click is a fresh search.
test('AC-10 hostLink.popupPort: a connected popup whose open is still pending closes with the gesture; the next click is fresh', async () => {
  holdGate('action.openPopup');
  const { hostLink, stepped } = launch('popup');
  await settle();
  const popup = browser.connect(portName(A), popupUrl(A));
  hostLink.close(A, 'commit');
  resolveGate();
  await settle();
  expect(popup.disconnected).toBe(true);
  browser.click(11);
  await settle();
  expect(stepped).toMatchObject([{ kind: 'toolbarClicked', source: { tabId: 11 } }]);
});

// C-POP-11, C-POP-09, KB-10
test('AC-10 hostLink.popupPort: configuration completing after the deadline opens no popup; the next click is fresh', async () => {
  holdGate('action.setPopup');
  const { hostLink, stepped } = launch('popup');
  await settle();
  hostLink.close(A, 'commit');
  resolveGate();
  await settle();
  browser.click(11);
  await settle();
  expect(browser.opened).toEqual([]);
  expect(stepped).toMatchObject([{ kind: 'toolbarClicked', source: { tabId: 11 } }]);
});

// C-POP-01, C-POP-04: failed falls back to the popup (T-08); closed cancels (T-20) (05-events 4.4).
test.each([
  { host: 'overlay', status: 'failed' },
  { host: 'popup', status: 'closed' },
] as const)(
  'AC-12 hostLink.preHandshakeEnd: the $host channel ending before ready reports $status',
  async ({ host, status }) => {
    const { stepped } = launch(host);
    await settle();
    const port = host === 'overlay' ? browser.connected[0] : browser.connect(portName(A), popupUrl(A));
    expect(port?.posted).toMatchObject([{ t: 'start' }]);
    port?.onDisconnect.dispatch(port);
    await settle();
    expect(stepped).toMatchObject([{ kind: 'hostStatus', attempt: A, status }]);
  },
);

// The page half of a channel: a session on its own port whose posts reach the worker's, mounted on a focused page.
function hostOn(worker: FakePort): FakePort {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true }));
  const page = createPort(worker.name);
  page.postMessage = (m) => {
    worker.onMessage.dispatch(m, worker);
  };
  const surface = { start: () => undefined, element: new EventTarget() } as unknown as ListSurface;
  const mounted = {
    surface,
    owns: () => false,
    latch: () => undefined,
    unlatch: () => undefined,
    hide: () => undefined,
  };
  runSession(page as unknown as chrome.runtime.Port, {
    alive: () => true,
    dispose: () => undefined,
    decline: () => null,
    mount: () => ({ ...mounted, remove: () => undefined }),
    focused: () => Promise.resolve(),
    closed: () => undefined,
  });
  for (const m of worker.posted) page.onMessage.dispatch(m, page);
  return page;
}

// T-14, C-HOLD-01: the foreground page wakes the worker at the dwell due, as the worker's own timer may fire late in
// a background process (05-events 2.3). The wake leaves out injection time; the ping follows ready.
test.each([50, 50.75])('hostLink.wake: injection takes 20 ms from a dwell due at %s', async (dwell) => {
  browser.gates['scripting.executeScript'] = sleep(20);
  const { stepped } = launch('overlay', dwell);
  await vi.advanceTimersByTimeAsync(20);
  const worker = browser.connected[0];
  if (!worker) throw new Error('no overlay port');
  expect(worker.posted).toEqual([{ t: 'start', start: START, wake: dwell - 20 }]);
  hostOn(worker);
  await vi.advanceTimersByTimeAsync(29);
  expect(stepped.map((e) => [e.kind, e.at])).toEqual([['hostStatus', 20]]);
  await vi.advanceTimersByTimeAsync(Math.ceil(dwell) - 49);
  expect(stepped).toMatchObject([
    { kind: 'hostStatus', status: 'ready' },
    { kind: 'host', at: Math.ceil(dwell), attempt: A, input: { kind: 'ping' } },
  ]);
});
