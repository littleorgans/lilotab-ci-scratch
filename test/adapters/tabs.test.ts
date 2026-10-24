// Tabs adapter: the private object guard and activation stages, against a fake chrome (07-tests 2.2, AC-07, AC-08;
// 05-events 3.1, 7).

import { beforeEach, expect, test } from 'vite-plus/test';
import { registerEntry } from '../../src/worker/adapters/entry/index.ts';
import { createTabs } from '../../src/worker/adapters/tabs/index.ts';
import { collect, installFakeChrome, noClosed, settle, tab, win, type FakeBrowser } from './fake-chrome.ts';

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeChrome();
});

// C-PRIV-08
test('AC-07 tabs.privateGuard: a private window or tab never becomes a live fact', async () => {
  browser.windows.push(win(2, { incognito: true }));
  browser.tabs.push(tab(13, 1, { incognito: true }), tab(21, 2, { incognito: true, active: true }));
  const live = await createTabs().liveFacts();
  expect(live.windows.map((w) => [w.windowId, w.tabs.map((t) => t.tabId)])).toEqual([[1, [11, 12]]]);
});

// C-PRIV-08: each row also acts on a normal object, which alone steps.
test.each<{ name: string; act: (b: FakeBrowser) => void; steps: object[] }>([
  {
    name: 'a private window created steps nothing',
    act: (b) => {
      b.createWindow(win(2, { incognito: true }));
      b.createWindow(win(3));
    },
    steps: [{ kind: 'windowCreated', windowId: 3 }],
  },
  {
    name: 'a press in a private tab steps nothing',
    act: (b) => {
      b.windows.push(win(2, { incognito: true }));
      b.tabs.push(tab(21, 2, { incognito: true, active: true }));
      b.press(21);
      b.press(11);
    },
    steps: [{ kind: 'command', source: { tabId: 11 } }],
  },
])('AC-07 tabs.privateGuard: $name', async ({ act, steps }) => {
  const { ingress, stepped } = collect();
  createTabs().onEvent(ingress);
  registerEntry(ingress, () => createTabs().liveFacts(), noClosed);
  act(browser);
  await settle();
  expect(stepped).toMatchObject(steps);
});

// C-WIN-07, C-TAP-08: each stage in order; the result names the stage that failed. Tab 21 lives in window 2.
test.each<{
  name: string;
  tabId?: number;
  focus?: boolean;
  fail?: 'tabs.update' | 'windows.update';
  result: string;
  log: string[];
}>([
  { name: 'activates the tab, then focuses its window: done', result: 'done', log: ['activate 21', 'focus 2'] },
  { name: 'without focusWindow, activates the tab only: done', focus: false, result: 'done', log: ['activate 21'] },
  { name: 'tab closed: gone', tabId: 29, result: 'gone', log: [] },
  { name: 'tab moved to another window: gone', tabId: 12, result: 'gone', log: [] },
  { name: 'activation refused: rejected', fail: 'tabs.update', result: 'rejected', log: [] },
  { name: 'window focus refused: focusFailed', fail: 'windows.update', result: 'focusFailed', log: ['activate 21'] },
])('AC-08 tabs.activation: $name', async ({ tabId = 21, focus = true, fail, result, log }) => {
  browser.windows.push(win(2));
  browser.tabs.push(tab(20, 2, { active: true }), tab(21, 2));
  if (fail) browser.failing.add(fail);
  const { ingress, stepped } = collect();
  const tabs = createTabs();
  tabs.onEvent(ingress);
  const target = { tabId, windowId: 2 };
  tabs.activate('boot:1', target, focus);
  await settle();
  expect(stepped).toMatchObject([{ kind: 'activated', op: 'boot:1', target, result }]);
  expect(browser.log).toEqual(log);
});
