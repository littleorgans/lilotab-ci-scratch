// A fake of the chrome API surface the entry, tabs and host link adapters call, so their contract tests run in Node
// (07-tests 2.2). A test holds a call back with a gate or makes it reject by name. Timers are Vitest's fakes, so
// Clock.now() (performance.now) starts at 0 and only moves when a test advances it.

import { onTestFinished, vi } from 'vite-plus/test';
import type { ClosedTab, CoreEvent, LiveTab } from '../../src/core/index.ts';
import { clock } from '../../src/worker/adapters/clock/index.ts';
import { createIngress, type Ingress } from '../../src/worker/ingress.ts';
import { POPUP_PAGE, SWITCH_COMMAND } from '../../src/worker/names.ts';
import { tab as liveTab } from '../data-fixtures.ts';

type Call =
  | 'commands.getAll'
  | 'windows.getAll'
  | 'windows.update'
  | 'tabs.update'
  | 'action.setPopup'
  | 'action.openPopup'
  | 'scripting.executeScript';

class FakeEvent<A extends unknown[]> {
  private readonly listeners: ((...args: A) => unknown)[] = [];
  addListener(listener: (...args: A) => unknown): void {
    this.listeners.push(listener);
  }
  dispatch(...args: A): void {
    for (const listener of this.listeners) listener(...args);
  }
}

interface Sender {
  id: string;
  url: string;
}

export interface FakePort {
  name: string;
  sender: Sender | undefined;
  posted: unknown[];
  disconnected: boolean; // by the worker; a popup closes on it (05-events 4.3)
  onMessage: FakeEvent<[unknown, FakePort]>;
  onDisconnect: FakeEvent<[FakePort]>; // dispatched by a test: the host's end went away
  postMessage(message: unknown): void;
  disconnect(): void;
}

function createPort(name: string, sender?: Sender): FakePort {
  const port: FakePort = {
    name,
    sender,
    posted: [],
    disconnected: false,
    onMessage: new FakeEvent(),
    onDisconnect: new FakeEvent(),
    postMessage: (message) => port.posted.push(message),
    disconnect: () => {
      port.disconnected = true;
    },
  };
  return port;
}

export interface FakeWindow {
  id: number;
  type: 'normal' | 'popup';
  focused: boolean;
  incognito: boolean;
}

export interface FakeTab extends Omit<LiveTab, 'tabId' | 'iconKey'> {
  id: number;
  windowId: number;
  incognito: boolean;
}

const EXTENSION_ID = 'lilotabfakeextensionid';
export const extensionUrl = (path: string): string => `chrome-extension://${EXTENSION_ID}/${path.replace(/^\//, '')}`;

export const popupUrl = (attempt: string): string => `${extensionUrl(POPUP_PAGE)}#${attempt}`;

export const tab = (id: number, windowId: number, more: Partial<FakeTab> = {}): FakeTab => {
  const { tabId: _tabId, iconKey: _iconKey, ...fields } = liveTab(id);
  return { ...fields, id, windowId, incognito: false, ...more };
};

export const win = (id: number, more: Partial<FakeWindow> = {}): FakeWindow => ({
  id,
  type: 'normal',
  focused: false,
  incognito: false,
  ...more,
});

function createBrowser() {
  const browser = {
    windows: [win(1, { focused: true })] as FakeWindow[],
    tabs: [tab(11, 1, { active: true }), tab(12, 1)] as FakeTab[],
    shortcut: 'Ctrl+Shift+E',
    gates: {} as Partial<Record<Call, Promise<unknown>>>, // a call waits for its gate before it acts
    failing: new Set<Call>(),
    popups: new Map<number, string>(), // each tab's action popup
    opened: [] as string[], // popup pages action.openPopup opened
    connected: [] as FakePort[], // ports the worker opened with tabs.connect
    log: [] as string[], // activation writes in order
    badge: { text: '', background: '', color: '' }, // the toolbar icon's badge
    // The browser's toolbar click: the tab's popup if one is set, else action.onClicked (C-POP-09).
    click(tabId: number): void {
      const page = browser.popups.get(tabId);
      if (page) browser.opened.push(page);
      else api.action.onClicked.dispatch(find(tabId));
    },
    press(tabId?: number, command = SWITCH_COMMAND): void {
      api.commands.onCommand.dispatch(command, tabId === undefined ? undefined : find(tabId));
    },
    createWindow(w: FakeWindow): void {
      browser.windows.push(w);
      api.windows.onCreated.dispatch(w);
    },
    createTab(t: FakeTab): void {
      browser.tabs.push(t);
      api.tabs.onCreated.dispatch(t);
    },
    removeTab(tabId: number): void {
      const { windowId } = find(tabId);
      browser.tabs = browser.tabs.filter((t) => t.id !== tabId);
      api.tabs.onRemoved.dispatch(tabId, { windowId, isWindowClosing: false });
    },
    // A port from an extension page, as runtime.connect from that page delivers it.
    connect(name: string, url: string): FakePort {
      const port = createPort(name, { id: EXTENSION_ID, url });
      api.runtime.onConnect.dispatch(port);
      return port;
    },
  };

  const find = (tabId: number): FakeTab => {
    const found = browser.tabs.find((t) => t.id === tabId);
    if (!found) throw new Error(`No tab with id: ${String(tabId)}.`);
    return found;
  };

  async function call<T>(name: Call, act: () => T): Promise<T> {
    await browser.gates[name];
    if (browser.failing.has(name)) throw new Error(`${name} failed`);
    return act();
  }

  const api = {
    commands: {
      onCommand: new FakeEvent<[string, FakeTab | undefined]>(),
      getAll: () => call('commands.getAll', () => [{ name: SWITCH_COMMAND, shortcut: browser.shortcut }]),
    },
    action: {
      onClicked: new FakeEvent<[FakeTab]>(),
      setBadgeText({ text }: { text: string }) {
        browser.badge.text = text;
        return Promise.resolve();
      },
      setBadgeBackgroundColor({ color }: { color: string }) {
        browser.badge.background = color;
        return Promise.resolve();
      },
      setBadgeTextColor({ color }: { color: string }) {
        browser.badge.color = color;
        return Promise.resolve();
      },
      getPopup: ({ tabId }: { tabId: number }) => Promise.resolve(browser.popups.get(tabId) ?? ''),
      setPopup: ({ tabId, popup }: { tabId: number; popup: string }) =>
        call('action.setPopup', () => {
          browser.popups.set(tabId, popup);
        }),
      // Opens the active tab's popup at once; the promise settles when the call's gate opens.
      openPopup({ windowId }: { windowId: number }) {
        const active = browser.tabs.find((t) => t.windowId === windowId && t.active);
        const page = active && browser.popups.get(active.id);
        if (page) browser.opened.push(page);
        return call('action.openPopup', () => {
          if (!page) throw new Error('No popup');
        });
      },
    },
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      getURL: extensionUrl,
      onConnect: new FakeEvent<[FakePort]>(),
    },
    scripting: {
      executeScript: ({ target }: { target: { tabId: number } }) =>
        call('scripting.executeScript', () => [{ frameId: 0, documentId: `doc-${String(target.tabId)}` }]),
    },
    tabs: {
      get: (tabId: number) => Promise.resolve().then(() => ({ ...find(tabId) })),
      update: (tabId: number, { active }: { active: boolean }) =>
        call('tabs.update', () => {
          const target = find(tabId);
          for (const t of browser.tabs) if (t.windowId === target.windowId) t.active = t.id === tabId && active;
          browser.log.push(`activate ${String(tabId)}`);
        }),
      connect: (_tabId: number, { name }: { name: string }) => {
        const port = createPort(name);
        browser.connected.push(port);
        return port;
      },
      onActivated: new FakeEvent(),
      onCreated: new FakeEvent<[FakeTab]>(),
      onRemoved: new FakeEvent(),
      onDetached: new FakeEvent(),
      onAttached: new FakeEvent(),
      onReplaced: new FakeEvent(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: ({ windowTypes }: { windowTypes: string[] }) =>
        call('windows.getAll', () =>
          browser.windows
            .filter((w) => windowTypes.includes(w.type))
            .map((w) => ({ ...w, tabs: browser.tabs.filter((t) => t.windowId === w.id).map((t) => ({ ...t })) })),
        ),
      update: (windowId: number, { focused }: { focused: boolean }) =>
        call('windows.update', () => {
          for (const w of browser.windows) w.focused = w.id === windowId && focused;
          browser.log.push(`focus ${String(windowId)}`);
        }),
      onCreated: new FakeEvent<[FakeWindow]>(),
      onRemoved: new FakeEvent(),
      onFocusChanged: new FakeEvent(),
    },
  };

  return { browser, api };
}

export type FakeBrowser = ReturnType<typeof createBrowser>['browser'];

// A fresh browser as the chrome global, with fake timers, both undone when the test finishes.
export function installFakeChrome(): FakeBrowser {
  const { browser, api } = createBrowser();
  vi.useFakeTimers();
  vi.stubGlobal('chrome', api);
  onTestFinished(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  return browser;
}

// Resolves after ms of fake time.
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// The worker's own ingress with its gate open, recording each event it steps (05-events 2.1).
export function collect(): { ingress: Ingress; stepped: CoreEvent[] } {
  const stepped: CoreEvent[] = [];
  const ingress = createIngress(clock, Promise.resolve(), (event) => {
    stepped.push(event);
  });
  return { ingress, stepped };
}

// Include recently closed tabs Off: the entry adapter reads none (C-SRCH-27).
export const noClosed = (): Promise<ClosedTab[]> => Promise.resolve([]);

// Runs every pending timer and promise job.
export const settle = (): Promise<unknown> => vi.runAllTimersAsync();
