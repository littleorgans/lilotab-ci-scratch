// Commands and toolbar action: prepares command, searchCommand and toolbarClicked events (03-components 3.2,
// 05-events 2.4).

import { readShortcut } from '../../../browser/commands.ts';
import {
  PREP_BUDGET_MS,
  parseBinding,
  type ClosedTab,
  type LiveFacts,
  type Millis,
  type Sink,
  type SourceTab,
} from '../../../core/index.ts';
import { reportCode } from '../../diagnostics.ts';
import { SEARCH_COMMAND, SWITCH_COMMAND } from '../../names.ts';
import { timing } from '../../timing/index.ts';
import { settleBy, type Settled } from '../clock/index.ts';
import { isPrivate } from '../tabs/index.ts';

// The tab a press or click came from; none for a Global shortcut (C-KEY-07) or a private tab (C-PRIV-08).
function sourceOf(tab: chrome.tabs.Tab | undefined): SourceTab | null {
  if (!tab || isPrivate(tab) || tab.id === undefined || tab.id < 0) return null;
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url ?? tab.pendingUrl ?? '' };
}

function failed(settled: Settled<unknown>, detail: string): void {
  if (!settled.ok) reportCode(settled.cause === 'timeout' ? 'prepTimeout' : 'prepFailed', detail);
}

type Entry = 'shortcut' | 'search';
type Reads = { liveFacts: () => Promise<LiveFacts>; closedTabs: (entry: Entry) => Promise<readonly ClosedTab[]> };

// Every query in parallel, each bounded by the press's at plus the budget. The binding is null when unbound or
// without Cmd, Ctrl or Alt (C-KEY-09, C-KEY-11). Recently closed tabs that fail or come late are none (C-SRCH-27).
async function prepare(at: Millis, reads: Reads, entry: Entry) {
  const until = at + PREP_BUDGET_MS;
  const [binding, live, closed] = await Promise.all([
    settleBy(readShortcut(SWITCH_COMMAND).then(parseBinding), until),
    settleBy(reads.liveFacts(), until),
    settleBy(reads.closedTabs(entry), until),
  ]);
  failed(binding, 'binding');
  failed(live, 'live');
  failed(closed, 'closed');
  if (
    timing &&
    ((!live.ok && live.cause === 'timeout') || (entry === 'shortcut' && !binding.ok && binding.cause === 'timeout'))
  ) {
    timing.dropped(entry, at);
  }
  const unusable = binding.ok && binding.value === null;
  return {
    binding: binding.ok ? binding.value : null,
    live: live.ok ? live.value : null,
    closed: closed.ok ? closed.value : [],
    unusable,
  };
}

export function registerEntry(
  sink: Sink,
  liveFacts: () => Promise<LiveFacts>,
  closedTabs: (entry: Entry) => Promise<readonly ClosedTab[]>,
): void {
  const reads: Reads = { liveFacts, closedTabs };
  // A search entry steps without a usable binding; it only loses the shortcut keys (C-POP-09, C-KEY-12).
  const search = (kind: 'toolbarClicked' | 'searchCommand', source: SourceTab): void => {
    sink(async (at) => {
      const { binding, live, closed } = await prepare(at, reads, 'search');
      return live ? { kind, at, source, binding, live, closed } : null;
    });
  };
  chrome.commands.onCommand.addListener((command, tab) => {
    const source = sourceOf(tab);
    if (!source) return;
    if (command === SEARCH_COMMAND) search('searchCommand', source);
    if (command !== SWITCH_COMMAND) return;
    sink(async (at) => {
      const { binding, live, closed, unusable } = await prepare(at, reads, 'shortcut');
      if (unusable) reportCode('prepFailed', 'unbound'); // the settings page says why (C-KEY-11)
      return binding && live ? { kind: 'command', at, source, binding, live, closed } : null;
    });
  });
  // Fires only while the tab has no action popup; the host link clears it after each opening (C-POP-09).
  chrome.action.onClicked.addListener((tab) => {
    const source = sourceOf(tab);
    if (source) search('toolbarClicked', source);
  });
}
