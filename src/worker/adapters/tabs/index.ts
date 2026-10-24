// Tabs and windows: browser events to core events, live facts, activation, private object guard (03-components 3.2).

import type { ActivationResult, LiveFacts, LiveTab, TabsAdapter } from '../../../core/index.ts';
import { iconKeyOf } from '../icons/index.ts';

// The one private object guard: applied to every Tab or Window before it becomes a fact (C-PRIV-08).
export const isPrivate = (o: { incognito: boolean }): boolean => o.incognito;

function liveTab(t: chrome.tabs.Tab & { id: number }): LiveTab {
  return {
    tabId: t.id,
    title: t.title ?? '',
    url: t.url ?? t.pendingUrl ?? '',
    pinned: t.pinned,
    audible: t.audible ?? false,
    active: t.active,
    iconKey: iconKeyOf(t),
  };
}

const hasId = <T extends { id?: number | undefined }>(o: T): o is T & { id: number } => o.id !== undefined && o.id >= 0;

// Normal windows in browser order, tabs in tab bar order (05-events 2.4).
async function liveFacts(): Promise<LiveFacts> {
  const all = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return {
    windows: all
      .filter((w) => !isPrivate(w))
      .filter(hasId)
      .map((w) => ({
        windowId: w.id,
        tabs: (w.tabs ?? [])
          .filter((t) => !isPrivate(t))
          .filter(hasId)
          .map(liveTab),
      })),
  };
}

// The stages of 05-events 7: each result names the stage that failed, so the core corrects only what did not happen.
async function activation(tabId: number, windowId: number, focusWindow: boolean): Promise<ActivationResult> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || isPrivate(tab) || tab.windowId !== windowId) return 'gone';
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    return 'rejected';
  }
  if (!focusWindow) return 'done';
  return chrome.windows.update(windowId, { focused: true }).then(
    () => 'done',
    () => 'focusFailed',
  );
}

export function createTabs(): TabsAdapter {
  let results: Parameters<TabsAdapter['onEvent']>[0] | null = null;
  return {
    liveFacts,
    activate(op, target, focusWindow) {
      void activation(target.tabId, target.windowId, focusWindow).then((result) => {
        results?.((at) => ({ kind: 'activated', at, op, target, result }));
      });
    },
    remove(tabId) {
      chrome.tabs.remove(tabId).catch(() => undefined);
    },
    // Every listener of 05-events 3.1 for tabs and windows; tabs.onUpdated is deliberately absent (05 3.2).
    onEvent(sink) {
      results = sink;
      chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
        sink((at) => ({ kind: 'tabActivated', at, tabId, windowId }));
      });
      chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
        sink((at) => ({ kind: 'tabRemoved', at, tabId, windowId, windowClosing: isWindowClosing }));
      });
      chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
        sink((at) => ({ kind: 'tabDetached', at, tabId, windowId: oldWindowId }));
      });
      chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
        sink((at) => ({ kind: 'tabAttached', at, tabId, windowId: newWindowId }));
      });
      chrome.tabs.onReplaced.addListener((added, removed) => {
        sink((at) => ({ kind: 'tabReplaced', at, added, removed }));
      });
      chrome.windows.onCreated.addListener((w) => {
        if (isPrivate(w) || !hasId(w)) return;
        sink((at) => ({ kind: 'windowCreated', at, windowId: w.id, normal: w.type === 'normal' }));
      });
      chrome.windows.onRemoved.addListener((windowId) => {
        sink((at) => ({ kind: 'windowRemoved', at, windowId }));
      });
      // Raw ids; the core classifies them. Focus moving out of the browser or to a private window reports NONE.
      // Receive other window types too: they count as leaving, without changing normal window recency.
      chrome.windows.onFocusChanged.addListener(
        (id) => {
          const windowId = id === chrome.windows.WINDOW_ID_NONE ? null : id;
          sink((at) => ({ kind: 'windowFocused', at, windowId }));
        },
        { windowTypes: ['normal', 'popup', 'panel', 'app', 'devtools'] },
      );
    },
  };
}
