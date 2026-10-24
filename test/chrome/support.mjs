import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const scrub = (value) =>
  String(value).replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>"'`\\]+/g, '[address redacted]');
// A catch handler for a host whose CDP session went away with its list: `absent` when the target closed or detached,
// any other error rethrown.
export const closedAs = (absent) => (e) => {
  if (/closed|detached/i.test(e.message)) return absent;
  throw e;
};
// Whether an address is the browser page at `page` under the browser's own scheme; Edge, for one, shows its chrome://
// pages as edge://.
export const browserPage = (address, page) => new RegExp(`^[a-z]+://${page}$`).test(address);
export async function until(fn, ms = 2500) {
  const end = Date.now() + ms;
  let value = null,
    error;
  do {
    try {
      value = await fn();
      if (value) return value;
    } catch (e) {
      error = e;
    }
    await pause(20);
  } while (Date.now() < end);
  throw new Error(
    `Timed out after ${ms} ms; last observation: ${scrub(JSON.stringify(value))}; ${scrub(error?.message ?? '')}`,
  );
}
// Settles as `fn` does, or rejects once `ms` pass with an error marked `exceeded`; the work itself carries on unobserved.
export function within(ms, fn, what = 'Work') {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${what} exceeded ${ms} ms`), { exceeded: ms }));
    }, ms);
  });
  return Promise.race([fn(), late]).finally(() => {
    clearTimeout(timer);
  });
}
// The scenario the current async work belongs to; work the bound cut off reads abandoned from here, even after it wakes.
const work = new AsyncLocalStorage();
export const abandoned = () => work.getStore()?.abandoned === true;
export class Evidence {
  constructor(out) {
    this.out = out;
    this.results = [];
    this.limits = [];
    this.metadata = {};
    fs.mkdirSync(out, { recursive: true });
  }
  write(name, value) {
    fs.writeFileSync(
      path.join(this.out, name),
      (typeof value === 'string'
        ? scrub(value)
        : JSON.stringify(value, (_, v) => (typeof v === 'string' ? scrub(v) : v), 2)) + '\n',
    );
    return name;
  }
  // While `bound` ({ ms, answers, restore }) is set, a scenario past `ms` fails alone: its work is abandoned and
  // `restore` returns the fixture state its cleanup would have. Once `answers` resolves false, or `restore` fails or
  // outlives `ms`, later scenarios record that without running, so the run still reaches its end.
  async scenario(id, expected, fn) {
    const start = Date.now(),
      bound = this.bound,
      run = { abandoned: false };
    let observation;
    try {
      if (bound && this.stalled) observation = { pass: false, harnessError: `Not run: ${this.stalled}` };
      else observation = await (bound ? within(bound.ms, () => work.run(run, fn), 'Scenario') : fn());
    } catch (e) {
      observation = { pass: false, harnessError: scrub(e.message), trace: scrub(e.stack) };
      if (e.exceeded) {
        run.abandoned = true;
        if (!(await bound.answers())) this.stalled = `the browser stopped answering in ${id}`;
        else
          try {
            observation.restored = await within(bound.ms, bound.restore, 'Cleanup');
          } catch (err) {
            observation.cleanupError = scrub(err.message);
            this.stalled = `the cleanup after ${id} did not finish`;
          }
      }
    }
    // A known product bug (expected text starts `KNOWN BUG`) records KNOWN while it fails and FAIL once it passes, so
    // a fix forces the mark's removal; only FAIL fails the run.
    const known = expected.startsWith('KNOWN BUG');
    const row = {
      id,
      ...observation,
      status:
        observation.harnessError || typeof observation.pass !== 'boolean'
          ? 'FAIL'
          : observation.pass === known
            ? 'FAIL'
            : known
              ? 'KNOWN'
              : 'PASS',
      ...(known && observation.pass ? { unexpectedPass: true } : {}),
      expected,
      elapsedMs: Date.now() - start,
    };
    delete row.pass;
    this.results.push(row);
    this.write(`${id}.json`, row);
    this.flush();
    process.stdout.write(`${row.status} ${id}\n`);
    return row;
  }
  flush() {
    const summary = {
      pass: this.results.filter((r) => r.status === 'PASS').length,
      fail: this.results.filter((r) => r.status === 'FAIL').length,
      known: this.results.filter((r) => r.status === 'KNOWN').length,
      total: this.results.length,
    };
    this.write('results.json', { metadata: this.metadata, summary, limits: this.limits, scenarios: this.results });
    this.write(
      'report.md',
      `# Headless Chrome smoke\n\n${summary.pass} PASS, ${summary.fail} FAIL, ${summary.known} KNOWN, ${summary.total} scenarios.\n\n| Scenario | Result | Expected | Evidence |\n| --- | --- | --- | --- |\n${this.results.map((r) => `| ${r.id} | ${r.status} | ${r.expected.replaceAll('|', '/')} | [measurement](${r.id}.json)${(r.artifacts ?? []).map((f) => `, [${f}](${f})`).join('')} |`).join('\n')}\n\n## Limits\n\n${this.limits.map((x) => `- ${x}`).join('\n')}\n`,
    );
  }
}
