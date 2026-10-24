// Host link: popup port checks, late popups and channels ending before ready, against a fake chrome (07-tests 2.2,
// AC-10, AC-12; 05-events 4.2 to 4.4).

import { beforeEach, expect, test } from 'vite-plus/test';
import { portName } from '../../src/core/index.ts';
import { registerEntry } from '../../src/worker/adapters/entry/index.ts';
import { createHostLink } from '../../src/worker/adapters/host-link/index.ts';
import { createTabs } from '../../src/worker/adapters/tabs/index.ts';
import { startView } from '../host-fixtures.ts';
import {
  collect,
  extensionUrl,
  installFakeChrome,
  noClosed,
  popupUrl,
  settle,
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
function launch(host: 'overlay' | 'popup') {
  const { ingress, stepped } = collect();
  const hostLink = createHostLink('overlay.js');
  hostLink.onEvent(ingress);
  registerEntry(ingress, () => createTabs().liveFacts(), noClosed);
  if (host === 'overlay') hostLink.mountOverlay(A, 11, START);
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
