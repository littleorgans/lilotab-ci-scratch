/// <reference types="@crxjs/vite-plugin/client" />

// Worker shell ingress and preparation budget against a fake chrome (07-tests 2.2, AC-01, AC-02; 05-events 2.1, 2.4).

import { beforeEach, expect, onTestFinished, test, vi } from 'vite-plus/test';
import { createTimers } from '../../src/worker/adapters/clock/index.ts';
import { registerEntry } from '../../src/worker/adapters/entry/index.ts';
import { createTabs } from '../../src/worker/adapters/tabs/index.ts';
import { SEARCH_COMMAND, SWITCH_COMMAND } from '../../src/worker/names.ts';
import { collect, installFakeChrome, noClosed, settle, sleep, tab, type FakeBrowser } from './fake-chrome.ts';

const timingHooks = vi.hoisted(() => ({ prepared: vi.fn(), dropped: vi.fn() }));
vi.mock('../../src/worker/timing/index.ts', () => ({ timing: timingHooks }));

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeChrome();
});

// Live facts that settle after the next delay in the list, one per press.
const liveAfter = (delays: number[]) => async () => {
  await sleep(delays.shift() ?? 0);
  return createTabs().liveFacts();
};

// C-SW-05, KB-02
test('AC-01 shell.ingressOrder: two presses whose preparations settle in reverse step in press order', async () => {
  browser.tabs.push(tab(13, 1));
  const { ingress, stepped } = collect();
  registerEntry(ingress, liveAfter([200, 10]), noClosed);
  browser.press(11);
  browser.press(13);
  await settle();
  expect(stepped).toMatchObject([
    { kind: 'command', source: { tabId: 11 } },
    { kind: 'command', source: { tabId: 13 } },
  ]);
});

// C-SW-04: the timer steps behind the press it queued after, with the at it fired at, which decides its expiry.
test('AC-01 shell.ingressOrder: a timer queued behind a preparing press steps after it with its own at', async () => {
  const { ingress, stepped } = collect();
  registerEntry(ingress, liveAfter([200]), noClosed);
  browser.press(11);
  createTimers(ingress).start('boot:1', 'hostDeadline', 100);
  await settle();
  expect(stepped.map((e) => [e.kind, e.at])).toEqual([
    ['command', 0],
    ['timer', 100],
  ]);
});

// C-POP-05 exception: the press's shortcut and open tabs must settle within 250 ms of it.
test.each([
  { facts: 'open tabs', call: 'windows.getAll', ms: 240, outcome: 'the press steps', steps: ['command'] },
  { facts: 'open tabs', call: 'windows.getAll', ms: 260, outcome: 'the press does nothing', steps: [] },
  { facts: 'shortcut', call: 'commands.getAll', ms: 260, outcome: 'the press does nothing', steps: [] },
] as const)('AC-02 shell.prepBudget: $facts at $ms ms, $outcome', async ({ call, ms, steps }) => {
  const { ingress, stepped } = collect();
  registerEntry(ingress, () => createTabs().liveFacts(), noClosed);
  browser.gates[call] = sleep(ms);
  browser.press(11);
  await settle(); // past the late result too: it is discarded
  expect(stepped.map((e) => e.kind)).toEqual(steps);
});

// Measurement must retain the preparation timeout without stepping a replacement event into the core.
test('a preparation timeout records a dropped shortcut or search press', async () => {
  for (const entry of ['shortcut', 'search'] as const) {
    vi.clearAllMocks();
    browser = installFakeChrome();
    const { ingress, stepped } = collect();
    registerEntry(ingress, liveAfter([260]), noClosed);
    if (entry === 'shortcut') browser.press(11);
    else browser.click(11);
    await settle();
    expect(stepped).toEqual([]);
    expect(timingHooks.dropped).toHaveBeenCalledWith(entry, expect.any(Number));
  }
});

// C-SW-01, C-SRCH-27: a search that wakes the worker reads sessions only once its stored setting has loaded; a switch
// press launches its host as the gate settles, never waiting on that read.
test.each([
  {
    press: 'search',
    command: SEARCH_COMMAND,
    outcome: 'includes recently closed tabs',
    ms: 160,
    reads: 1,
    start: { mode: 'search', view: { closed: [{ title: 'Closed' }] } },
  },
  {
    press: 'switch',
    command: SWITCH_COMMAND,
    outcome: 'launches its host without them',
    ms: 110,
    reads: 0,
    start: { mode: 'hold' },
  },
] as const)(
  'AC-02 shell.prepBudget: the $press press that wakes the worker $outcome',
  async ({ command, ms, reads, start }) => {
    vi.resetModules();
    vi.doMock('../../src/hosts/overlay/index.ts?script&iife', () => ({ default: 'overlay.js' }));
    vi.doMock('../../src/worker/timing/index.ts', () => ({ timing: null }));
    vi.doMock('../../src/worker/adapters/storage/index.ts', () => ({
      sessionStore: { load: () => Promise.resolve(undefined) },
      settingsStore: {
        load: async () => {
          await sleep(100);
          return { version: 1, closedTabs: 'on' };
        },
        onChanged: vi.fn(),
      },
      createSaver: () => ({ checkpoint: vi.fn() }),
      registerClear: vi.fn(),
      restrictLocal: vi.fn(),
    }));
    onTestFinished(() => {
      vi.doUnmock('../../src/hosts/overlay/index.ts?script&iife');
      vi.doUnmock('../../src/worker/timing/index.ts');
      vi.doUnmock('../../src/worker/adapters/storage/index.ts');
    });
    Object.assign(chrome.runtime, { onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() } });
    const getRecentlyClosed = vi.fn(async () => {
      await sleep(50);
      return [{ tab: { ...tab(13, 1, { title: 'Closed' }), sessionId: 's1' } }];
    });
    Object.assign(chrome, { sessions: { getRecentlyClosed } });
    await import('../../src/worker/index.ts');
    browser.press(11, command);
    await vi.advanceTimersByTimeAsync(ms);
    expect(browser.connected[0]?.posted[0]).toMatchObject({ t: 'start', start });
    expect(getRecentlyClosed).toHaveBeenCalledTimes(reads);
  },
);
