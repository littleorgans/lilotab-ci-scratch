#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chrome } from './chrome.mjs';
import { Evidence, scrub } from './support.mjs';
import { lookScenarios } from './look.mjs';
import { behaviorScenarios, thrown } from './behavior.mjs';
import { motionScenarios } from './motion.mjs';
import { journeyScenarios } from './journeys.mjs';
import { contractScenarios } from './contracts.mjs';

const args = process.argv.slice(2),
  option = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
if (!option('--ext') || !option('--out')) {
  process.stderr.write(
    'Usage: node test/chrome/run.mjs --ext <built unpacked extension> --out <new output directory> [--only <id substring>] [--chrome <executable>]\n',
  );
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ext = path.resolve(option('--ext')),
  out = path.resolve(option('--out'));
if (!fs.existsSync(path.join(ext, 'manifest.json'))) {
  process.stderr.write('Built manifest missing\n');
  process.exit(2);
}
if (fs.existsSync(out) && fs.readdirSync(out).length) {
  process.stderr.write('Refusing to overwrite nonempty output directory\n');
  process.exit(2);
}
const e = new Evidence(out);
const c = new Chrome({ ext, cache: path.join(root, '.smoke/browsers'), chrome: option('--chrome') }, e);
// Four times the slowest scenario on any matrix cell (AC-03-welcome-once, under 8 s).
e.bound = { ms: 30000, answers: () => c.answers(), restore: () => c.scenario.clean({ recover: true }) };
const scenarios = [];
const add = (id, expected, fn) => scenarios.push({ id, expected, fn });
lookScenarios(c, e, add);
motionScenarios(c, e, add);
behaviorScenarios(c, e, add);
journeyScenarios(c, e, add);
contractScenarios(c, e, add);
let setupError;
try {
  await c.start();
} catch (err) {
  setupError = scrub(err.stack);
  Object.assign(e.metadata, { setupError, setupStage: c.stage });
}
try {
  // A failed setup is one verdict, its stage in the metadata; no scenario runs without the browser, extension and
  // fixtures.
  if (setupError)
    await e.scenario('setup', 'The browser starts with the extension loaded and its fixtures ready', () => ({
      pass: false,
      harnessError: setupError,
    }));
  else
    for (const { id, expected, fn } of scenarios.filter((s) => !option('--only') || s.id.includes(option('--only')))) {
      await e.scenario(id, expected, async () => {
        const offset = (await c.workerMessages()).length;
        let result, reset, failure;
        try {
          reset = await c.reset();
          result = await fn();
        } catch (err) {
          failure = err;
        }
        // Before thrown, as the scenario's own finally blocks were; the scenario's error outranks the cleanup's.
        await c.scenario.clean().catch((err) => {
          failure ??= err;
        });
        if (failure) result = await thrown(c, failure);
        return {
          ...result,
          ...(reset && Object.keys(reset).length ? { reset } : {}),
          trace: (await c.workerMessages()).slice(offset),
        };
      });
    }
} finally {
  let clean = false;
  try {
    clean = await c.stop();
  } catch (err) {
    e.write('cleanup-error.txt', scrub(err.stack));
  }
  // Shutdown reports what the browser left, whether or not it stopped answering.
  e.bound = null;
  await e.scenario('shutdown', 'Owned Chrome and all processes using its unique disposable profile exit', () => ({
    pass: clean,
    measured: { clean, profile: c.process?.profile },
    artifacts: ['browser-shutdown.json'],
  }));
  e.flush();
  process.exitCode = e.results.some((r) => r.status === 'FAIL') ? 1 : 0;
}
