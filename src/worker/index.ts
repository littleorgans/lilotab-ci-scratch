// Service worker shell: composition root (03-components 3.2, 5.2). Registers every listener synchronously at top
// level, runs one init gate, steps ingress in order and initiates effects without awaiting them. Holds no rules.

import { PREP_BUDGET_MS, init, step, type Effect, type Model } from '../core/index.ts';
// The host link injects this file with scripting.executeScript({ files }); importing it here makes CRXJS bundle it as
// one classic self contained file, which needs no web accessible resource (C-SEC-05).
import overlayFile from '../hosts/overlay/index.ts?script&iife';
import { createBadge } from './adapters/badge/index.ts';
import { clock, createTimers, settleBy, type Settled } from './adapters/clock/index.ts';
import { registerEntry } from './adapters/entry/index.ts';
import { createHostLink } from './adapters/host-link/index.ts';
import { createIcons, deliverIcons } from './adapters/icons/index.ts';
import { recentlyClosed, restore } from './adapters/sessions/index.ts';
import { createSaver, registerClear, restrictLocal, sessionStore, settingsStore } from './adapters/storage/index.ts';
import { createTabs } from './adapters/tabs/index.ts';
import { fault, report, reportCode } from './diagnostics.ts';
import { createIngress } from './ingress.ts';
import { WELCOME_PAGE } from './names.ts';
import { timing } from './timing/index.ts';

const boot = crypto.randomUUID(); // new per evaluation; no ':' or '|' (core types BootId)
let model: Model | null = null;

const tabs = createTabs();
const liveFacts = () => tabs.liveFacts();
const hostLink = createHostLink(overlayFile);
const icons = createIcons();
const saver = createSaver(sessionStore);
const badge = createBadge(liveFacts);

// Effects in list order, each initiated and never awaited (03 4.1).
function perform(effects: readonly Effect[]): void {
  for (const effect of effects) {
    try {
      initiate(effect);
    } catch (error) {
      fault(error);
    }
  }
}

function initiate(e: Effect): void {
  switch (e.kind) {
    case 'startTimer':
      timers.start(e.id, e.timer, e.due);
      break;
    case 'cancelTimer':
      timers.cancel(e.id, e.timer);
      break;
    case 'mountOverlay':
      hostLink.mountOverlay(e.attempt, e.tabId, e.start);
      break;
    case 'openPopup':
      hostLink.openPopup(e.attempt, e.tabId, e.windowId, e.start);
      break;
    case 'render':
      hostLink.send(e.attempt, { t: 'frame', frame: e.frame });
      break;
    case 'loadIcons':
      deliverIcons(icons, e.keys, (patch) => {
        hostLink.send(e.attempt, { t: 'icons', icons: patch });
      });
      break;
    case 'closeHost':
      hostLink.close(e.attempt, e.outcome);
      break;
    case 'activate':
      tabs.activate(e.op, e.target, e.focusWindow);
      break;
    case 'closeTab':
      tabs.remove(e.tabId);
      break;
    case 'restoreTab':
      restore(e.sessionId);
      break;
    case 'checkpoint':
      saver.checkpoint(e.envelope, e.reply);
      break;
    case 'showBadge':
      badge.show(e.on);
      break;
    case 'saveSettings': // a failed write back changes nothing at run time; the next boot migrates again (06 4.3)
      settingsStore.save(e.settings).catch(() => {
        reportCode('settingsSaveFailed');
      });
      break;
    case 'diagnostic':
      report(e.entry);
      break;
  }
}

// The init gate (03 5.2): envelope, settings and live facts, each counted as rejected 250 ms after the gate starts.
function valueOr<T>(settled: Settled<T>, failure: Parameters<typeof reportCode>[0]): T | undefined {
  if (settled.ok) return settled.value;
  reportCode(failure, settled.cause);
  return undefined;
}

async function initGate(): Promise<void> {
  const until = clock.now() + PREP_BUDGET_MS;
  const [stored, settings, live] = await Promise.all([
    settleBy(sessionStore.load(), until),
    settleBy(settingsStore.load(), until),
    settleBy(tabs.liveFacts(), until),
  ]);
  const booted = init(
    boot,
    valueOr(stored, 'envelopeReadFailed'),
    valueOr(settings, 'settingsReadFailed'),
    valueOr(live, 'liveFactsFailed') ?? null,
  );
  model = booted.model;
  perform(booted.effects);
}

const gate = initGate().catch(fault);
if (timing) {
  void gate.then(() => {
    timing?.gate();
  });
}

// One step per event, in seq order, never two at once (03 3.2).
const ingress = createIngress(clock, gate, (event) => {
  if (!model) return; // the gate failed outright: nothing can step this boot
  const before = model;
  const next = step(model, event);
  model = next.model;
  perform(next.effects);
  timing?.stepped(before, event, next);
});
const timers = createTimers(ingress);

// ---- top level listeners: MV3 wakes the worker for an event only if its listener exists at first evaluation

// Recently closed tabs only while Include recently closed tabs is On (C-SRCH-27); the adapter reads none without
// permission (C-SET-29). A search that wakes the worker waits for the stored setting, within its preparation budget
// (C-SW-01); a switch press never waits on the gate for this read, so on wake it carries none.
registerEntry(ingress, liveFacts, async (entry) => {
  if (entry === 'search') await gate;
  return model?.settings.closedTabs === 'on' ? recentlyClosed() : [];
});
tabs.onEvent(ingress);
hostLink.onEvent(ingress);
badge.onEvent();
settingsStore.onChanged(ingress);
registerClear(ingress, saver, liveFacts);
restrictLocal();

// Install opens the welcome tab once; update and reload open nothing: the init gate already ran (05 3.1, C-KEY-10).
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE) }).catch(fault);
  }
});
// Registered only so the worker evaluates at browser start and the init gate seeds history (C-REC-09).
chrome.runtime.onStartup.addListener(() => undefined);
