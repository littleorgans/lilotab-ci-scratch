# Lilotab

Switch Chrome tabs from the keyboard, the way Cmd+Tab switches apps. By littleorgans; see [lilotab.com](https://lilotab.com).

Tap the shortcut to jump back to your last tab. Hold it to see every tab in the window, most recent first, and release to switch.

## Why Lilotab

- **Your last tab is one tap away.** Chrome's Ctrl+Tab moves by position in the tab strip. Lilotab goes back to the tab you actually used last.
- **One shortcut does it all.** Tap to flip, hold for the list, press F while holding to search. Your hands stay on the keyboard.
- **Every window, not just this one.** Left and Right step through your windows. Search covers tabs across all of them.
- **Works where you are.** The list opens over the page, above dialogs and fullscreen content. On pages that cannot host it, such as browser pages or PDFs, it opens in the toolbar popup.
- **Small footprint.** No access to the sites you visit until you press the shortcut, no network and no account. See [Privacy](#privacy).

## Install

**Chrome Web Store: link coming soon.**

Requires desktop Chrome 148 or later. Lilotab does not run in private windows.

The default shortcut is Cmd+E on macOS and Alt+Q elsewhere. Change it at `chrome://extensions/shortcuts`. A welcome tab shows your shortcut on first install.

Vivaldi is out of the browser test matrix for now: it rejects `chrome.action.openPopup` (Vivaldi bug VB-120122), so the toolbar popup does not open there.

### Load unpacked

Until the Store listing is live, build Lilotab from source. You need Node 24.22.1 and just 1.59, as pinned in `mise.toml`.

1. Clone this repository, then run `just install` and `just build`. The build writes the extension to `dist/`.
2. Open `chrome://extensions` and turn on Developer mode.
3. Click Load unpacked and choose the `dist/` folder.

`just build-timing` creates a measurement build in `dist-timing/` with the gesture timing log on the options page; load it unpacked from that folder and never ship it. `just build` stays a release build in `dist/`.

## How it works

- **Tap** the shortcut to switch to your last used tab.
- **Hold** the modifier to see the tabs in this window, most recent first. Press the shortcut letter again or use the arrow keys to move, then release to switch.
- **Windows:** Left and Right step through windows on a strip of window icons.
- **Search:** press F while holding to search tabs across every window. Press the modifier and F again to drop the query and go back to the window list, then release to switch.
- **Toolbar:** click the toolbar icon to search all your tabs.

**Settings:** quick tap (flip to last tab or open the list), quick tap scope, hold delay, tab order, where the list shows, recently closed tabs in search, a tab count badge, theme, text size and reduce motion, plus clearing history and restoring defaults.

## Privacy

- **No network.** Lilotab makes no network requests and has no account, sync or telemetry. Tab icons come from the browser's own favicon cache.
- **No standing site access.** It asks for no host permissions and runs no content scripts. It reaches a page only when you press the shortcut on it.
- **Permissions:** `storage`, `tabs`, `favicon`, `activeTab` and `scripting`, plus the optional `sessions`, asked for only when you turn on recently closed tabs in search and given back when you turn it off. Nothing else.
- **Stays on your device.** Settings live in Chrome's local extension storage. Recent tab history lives in session storage and clears when the browser closes or Lilotab updates.

## Contributing

We are not accepting pull requests. Bug reports and suggestions are welcome: please [open an issue](https://github.com/littleorgans/lilotab/issues).

Source available under PolyForm Perimeter 1.0.1 (LICENSE). Providing a competing product, including a free rebranded store copy, is not permitted. See TRADEMARKS.md.
