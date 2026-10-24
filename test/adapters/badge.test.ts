// Badge adapter: the tab count on the toolbar icon, against a fake chrome (07-tests AC-33; 05-events 3.1).

import { beforeEach, expect, test } from 'vite-plus/test';
import { createBadge } from '../../src/worker/adapters/badge/index.ts';
import { createTabs } from '../../src/worker/adapters/tabs/index.ts';
import { installFakeChrome, settle, tab, win, type FakeBrowser } from './fake-chrome.ts';

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeChrome();
});

// C-SET-27, C-WIN-14, C-PRIV-08: window 1 starts with tabs 11 and 12.
test.each<{ name: string; act: (b: FakeBrowser, show: (on: boolean) => void) => void; text: string }>([
  {
    name: 'On shows the count of tabs in listed windows only',
    act: (b, show) => {
      b.windows.push(win(2, { type: 'popup' }), win(3, { incognito: true }));
      b.tabs.push(tab(21, 2), tab(31, 3, { incognito: true }));
      show(true);
    },
    text: '2',
  },
  {
    name: 'Off clears the badge',
    act: (_b, show) => {
      show(true);
      show(false);
    },
    text: '',
  },
  {
    name: 'a created tab recounts',
    act: (b, show) => {
      show(true);
      b.createTab(tab(13, 1));
    },
    text: '3',
  },
  {
    name: 'a removed tab recounts',
    act: (b, show) => {
      show(true);
      b.removeTab(12);
    },
    text: '1',
  },
  {
    name: 'above 999 shows 999+',
    act: (b, show) => {
      for (let id = 100; id < 1100; id++) b.tabs.push(tab(id, 1));
      show(true);
    },
    text: '999+',
  },
])('AC-33 badge.count: $name', async ({ act, text }) => {
  const tabs = createTabs();
  const badge = createBadge(() => tabs.liveFacts());
  badge.onEvent();
  act(browser, (on) => {
    badge.show(on);
  });
  await settle();
  expect(browser.badge.text).toBe(text);
});
