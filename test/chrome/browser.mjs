import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import puppeteer from 'puppeteer-core';
import { Browser, install } from '@puppeteer/browsers';
import { pause, scrub } from './support.mjs';

export const CHROME_BUILD = '156.0.8078.47';
// Harness profile processes as `pid ppid command` on Windows, which has no pgrep or ps; PowerShell filters by the
// profile path, read from the environment to avoid quoting it.
const windowsProfileProcesses = (profile) =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:HARNESS_PROFILE) } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
    ],
    { encoding: 'utf8', env: { ...process.env, HARNESS_PROFILE: profile } },
  )
    .split(/\r?\n/)
    .filter(Boolean);
// The executable at `chrome`, else the pinned Chrome for Testing, fetched into `cache` once; later runs reuse it offline.
export async function installChrome({ chrome, cache }) {
  const installed = chrome
    ? { executablePath: chrome }
    : await install({ browser: Browser.CHROME, buildId: CHROME_BUILD, cacheDir: cache });
  if (!fs.existsSync(installed.executablePath)) throw new Error('Chrome executable missing; check --chrome');
  return installed.executablePath;
}
// One browser process on its own disposable profile under `out`: its launch, its log and what it leaves at exit.
export class BrowserProcess {
  #out;
  #profile;
  #pid;
  constructor(out) {
    this.#out = out;
    this.#profile = fs.mkdtempSync(path.join(out, 'profile-'));
  }
  get profile() {
    return this.#profile;
  }
  get pid() {
    return this.#pid;
  }
  async launch(executablePath) {
    // browser.log takes the browser's stderr and exit from spawn, so a browser that dies during launch still leaves
    // its output, exit code and signal. The launch's first child process is the browser; its stdio exists once spawn
    // returns.
    const log = path.join(this.#out, 'browser.log');
    const capture = ({ process: child }) => {
      queueMicrotask(() => {
        diagnostics.unsubscribe('child_process', capture);
        child.stderr?.on('data', (s) => {
          fs.appendFileSync(log, scrub(s));
        });
        child.once('exit', (code, signal) => {
          fs.appendFileSync(log, `browser exited: code ${code}, signal ${signal}\n`);
        });
      });
    };
    diagnostics.subscribe('child_process', capture);
    const browser = await puppeteer.launch({
      executablePath,
      userDataDir: this.#profile,
      headless: true,
      enableExtensions: true,
      pipe: true,
      defaultViewport: null,
      args: [
        // Lets the pipe connection load the build (Extensions.loadUnpacked); branded Chrome ignores --load-extension.
        '--enable-unsafe-extension-debugging',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--screen-info={1920x1080}',
        '--window-size=1440,900',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        // Puppeteer's defaults too, stated so no browser reaches the OS keychain or password store.
        '--use-mock-keychain',
        '--password-store=basic',
      ],
    });
    this.#pid = browser.process().pid;
    return browser;
  }
  // After the browser closed: whether its process still answers, and any process left using the profile.
  async exited() {
    let alive = false;
    try {
      process.kill(this.#pid, 0);
      alive = true;
    } catch {
      // ESRCH: the browser process is gone.
    }
    let remaining = [],
      processCheckError = null;
    // pgrep matches the profile path in each command line, so output scales with harness processes, never the whole
    // machine; pgrep exits 1 when none match, ps exits 1 when a listed pid has exited since.
    const run = (cmd, args) => {
      try {
        return execFileSync(cmd, args, { encoding: 'utf8' });
      } catch (err) {
        if (err.status === 1) return err.stdout;
        throw err;
      }
    };
    const profileProcesses = () => {
      if (process.platform === 'win32') return windowsProfileProcesses(this.#profile);
      const pids = run('pgrep', ['-f', this.#profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]).trim();
      return pids
        ? run('ps', ['-o', 'pid=,ppid=,command=', '-p', pids.split('\n').join(',')])
            .split('\n')
            .filter(Boolean)
        : [];
    };
    // Children can outlive the browser by a moment (Opera's crash reporter on Windows), so a remainder gets 3 s.
    try {
      const end = Date.now() + 3000;
      do {
        await pause(100);
        remaining = profileProcesses();
      } while (remaining.length && Date.now() < end);
    } catch (err) {
      processCheckError = scrub(err.message);
    }
    return { pid: this.#pid, alive, remaining, processCheckError };
  }
}
