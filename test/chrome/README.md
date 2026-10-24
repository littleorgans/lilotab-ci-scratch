# Headless Chrome smoke

Loads the release extension into private headless Chrome for Testing. Input uses CDP browser events. Native shortcut delivery and real foreground window focus remain unverified.

```sh
mise exec -- just smoke                       # build and run every scenario
mise exec -- just smoke --only AC-19           # scenario id substring, plus shutdown
mise exec -- just smoke --chrome <executable>  # override the pinned Chrome build
```

Exit 0 means no FAIL, including shutdown; FAIL exits 1; invalid arguments exit 2. A setup that stops records one `setup` FAIL naming its stage (launch, extension load, fixture windows, window focus, toolbar action, overlay world) and runs no scenario. Each scenario has a 30 s bound: one that outlives it fails alone. Its work is abandoned, any protocol command it sends later is refused, and the harness restores the fixture state (no list or popup, no stray tab, the recent order) before the next scenario. Once the worker then stops answering, or that restore fails or outlives 30 s, the remaining scenarios record FAIL without running, so every run reaches shutdown. `expected` text starting `KNOWN BUG` marks a product failure: an unmet contract reports KNOWN, a met contract reports FAIL with `unexpectedPass`, and a harness error always reports FAIL. `Evidence.scenario` owns this decision; checks return the ordinary contract result.

Each run retains `.smoke/runs/<UTC time>/`: `results.json`, `report.md`, per scenario JSON and screenshots, build hashes, shutdown evidence and a disposable profile. Addresses are scrubbed in string values before JSON encoding. Puppeteer dependencies and `CHROME_BUILD` are pinned; first use downloads Chrome into `.smoke/browsers/`, later runs reuse it. Both directories are ignored by git.

## Browser matrix

`.github/workflows/browser-matrix.yml` runs the harness on `ubuntu-latest` and `windows-latest` against the pinned Chrome for Testing, Chrome for Testing 148 (the manifest minimum), Google Chrome, Microsoft Edge, Brave, Opera and Vivaldi, each installed through its vendor channel by `.github/scripts/install-browser.sh`. Trigger it from the Actions tab or `gh workflow run browser-matrix.yml`; pushes to `main` that change the extension, harness or toolchain also run it. It is never a required check. Each cell writes one job summary line through `summary.mjs` (browser, version, PASS / FAIL / KNOWN counts, SETUP FAIL with its stage, or SKIP with its reason) and uploads its run folder without profiles as the `smoke-<os>-<browser>` artifact, kept 7 days.

## Coverage

Every scenario names its contract or known bug in its expected text. AC and JY ids refer to `docs/design/07-tests.md`; 5.9 and 5.10 refer to the internal specification section 5, items 9 and 10.

| Group                         | Scenario ids                                                           | Plan / contract                                                         |
| ----------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Geometry                      | `9-geometry-*`                                                         | AC-25, 5.9; C-WIN-16, C-SET-09                                          |
| Motion                        | `9-motion-*`, `9-switch-cut-*`, `9-os-change-*`, `9-swap-interruption` | AC-25, 5.9; C-A11Y-04, C-SET-08, C-HOLD-09                              |
| Theme and surface             | `owner-settings-*`, `owner-overlay-glass-*`, `9-popup-solid`           | AC-25, 5.9; C-SET-06, C-HOLD-26                                         |
| Sound                         | `sound-*`                                                              | AC-22, AC-23; C-HOLD-25                                                 |
| List input, focus and cleanup | `10-*`                                                                 | AC-16, 5.10; C-TAP-10, C-TAP-11, C-HOLD-12, C-SRCH-20, C-SW-02, C-SW-03 |
| Journeys and traffic          | `JY-1-*` through `JY-9-*`                                              | JY-1 to JY-9, including C-WIN-06 global history stepping                |
| Overlay                       | `AC-15-*` through `AC-19-*`                                            | AC-15 to AC-19; C-SEC-01, C-KEY-06, C-HOLD-18, C-HOLD-20, C-SEC-03      |
| Shared list                   | `AC-22-*` through `AC-25-*`                                            | AC-22 to AC-25; rows, semantics, scrolling, contrast and text size      |
| Icons                         | `AC-14-*`                                                              | AC-14; C-ICON-01, C-ICON-05, C-ICON-07                                  |
| Pages                         | `AC-26-*` through `AC-29-*`                                            | AC-26 to AC-29; shortcut, saves, defaults, locking and clear feedback   |
| Lifecycle                     | `AC-03-*`, `AC-09-*`, `AC-20-*`                                        | AC-03, AC-09, AC-20; install welcome, recents reset, orphan cleanup     |
| Package                       | `AC-30-*` through `AC-32-*`; `test/manifest.test.ts`                   | AC-30 to AC-32; names, permissions, script / ZIP size, release exposure |
| Harness shutdown              | `shutdown`                                                             | Owned browser process and profile process cleanup                       |

`AC-26-shortcut-default` uses the known failure marker on Edge for Windows and Linux only; its expected text resolves after setup, once the browser is known.

## Harness boundaries

Every browser launch, the lifecycle browser included, passes `--use-mock-keychain` and `--password-store=basic` and gets its own fresh profile under the run folder, so no run touches the OS keychain or a real profile. The build loads over the pipe through CDP `Extensions.loadUnpacked`, since branded Google Chrome ignores `--load-extension`.

The harness drives the worker running the manifest's service worker script, ignoring a browser's bundled extension workers. An initial window closes down to one tab first, since Brave keeps a window of several tabs open and then crashes when its last tab closes; one still open after 2 s stays, listed in `fixtures.json`. `Chrome.reset` closes earlier hosts before every scenario. `Chrome.open` owns popups before startup checks and requires a fresh worker ready. Fixtures provide 14 normal windows and 16 tabs, with a pinned Audio tab, a busy page, a PDF and iframe focus. Fixture setup closes every tab the harness did not open, such as the welcome tab. In Vivaldi it creates each fixture window and tab only once Vivaldi's own window page shows the one before: a page that misses a tab adds an active start page in its place and never shows the tab. The Audio tab is pinned by update, since Vivaldi ignores pinning at creation. Extra tabs and temporary browser API substitutions are restored after their scenario.

Commands call the registered worker listener; toolbar presses use `Extensions.triggerAction`, except in Vivaldi, whose browser process that command crashes: there the press makes the call Vivaldi's own toolbar button makes, `vivaldi.extensionActionUtils.executeExtensionAction`. Vivaldi's `chrome.action.openPopup` always rejects (Vivaldi bug VB-120122), so no popup opens there and popup scenarios fail. No press or command comes within 1 s of a popup closing: Opera's extension renderer, which also runs the worker, crashes when a popup reopens sooner. Held key input follows the manifest's suggested shortcut for the platform: Cmd on macOS, Ctrl elsewhere. Where the browser leaves that shortcut unset (Edge, whose Ctrl+Shift+E clashes), the harness assigns Ctrl+Shift+9 through the shortcuts page API, records `shortcutSimulated` in the metadata and job summary. `AC-26-shortcut-default` reports KNOWN on Edge for Windows and Linux, pending the owner ruled per browser default. `grant` supplies the activeTab grant through the toolbar. The probe observes the closed shadow tree through CDP, animation effects, input prevention, listeners and timers. Motion is paused for inspection. Ping and timeout checks invoke registered callbacks; natural scheduling and suspension remain unverified.

Journeys observe window focus requests because headless focus state is unreliable. `Chrome.focus` also accepts focus held by a guest view the page embeds, as Edge shows a PDF. JY-7 to JY-9 examine traffic recorded up to those checks, with positive controls; later adapter checks are outside that observation interval. Lifecycle uses a second disposable browser and same path unpacked reload. Sound substitutes the browser audible fact. A popup outside press may require a recorded minimize / restore substitute. Native dismissal, natural audio, real extension update, OS media delivery, GPU blur quality and Linux remain unverified.

## Files

- `run.mjs`, `support.mjs`: CLI, status classification, polling and evidence.
- `summary.mjs`: one browser matrix job summary line from `results.json`.
- `chrome.mjs`, `fixtures.mjs`, `fixture.html`, `probe.mjs`: browser lifecycle, fixture server / tabs and observation.
- `look.mjs`, `motion.mjs`, `behavior.mjs`, `journeys.mjs`: visual, input and journey checks.
- `contracts.mjs`, `pages.mjs`, `lifecycle.mjs`, `package.mjs`: adapter groups.
