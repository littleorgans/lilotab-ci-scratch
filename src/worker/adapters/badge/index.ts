// Tab count badge on the toolbar icon, outside ingress: the core's showBadge turns it on and off, tab events
// recount (C-SET-27; 05-events 3.1).

import { badgeText, type LiveFacts } from '../../../core/index.ts';
import { fault, reportCode } from '../../diagnostics.ts';

const BACKGROUND = '#6e6e73'; // neutral grey
const TEXT = '#ffffff';

export function createBadge(liveFacts: () => Promise<LiveFacts>) {
  let on = false;
  let reading = false;
  let dirty = false;

  const setText = (text: string): void => {
    void chrome.action.setBadgeText({ text }).catch(fault);
  };

  // One read in flight; an event during it reruns once after it (05-events 3.1).
  async function recount(): Promise<void> {
    dirty = true;
    if (reading) return;
    reading = true;
    try {
      while (dirty) {
        dirty = false;
        const live = await liveFacts();
        if (on) setText(badgeText(live));
      }
    } catch (error) {
      reportCode('liveFactsFailed', String(error)); // the badge keeps its last count until the next event
    } finally {
      reading = false;
    }
  }

  const schedule = (): void => {
    if (on) void recount();
  };

  return {
    show(next: boolean): void {
      on = next;
      if (!on) {
        setText('');
        return;
      }
      void chrome.action.setBadgeBackgroundColor({ color: BACKGROUND }).catch(fault);
      void chrome.action.setBadgeTextColor({ color: TEXT }).catch(fault);
      void recount();
    },
    // Registered synchronously at top level, so each event wakes the worker (C-SW-03).
    onEvent(): void {
      chrome.tabs.onCreated.addListener(schedule);
      chrome.tabs.onRemoved.addListener(schedule);
      chrome.tabs.onAttached.addListener(schedule);
      chrome.tabs.onDetached.addListener(schedule);
    },
  };
}
