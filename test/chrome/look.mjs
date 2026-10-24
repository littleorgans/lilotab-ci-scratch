import path from 'node:path';
import { pause, until } from './support.mjs';
import { HELD } from './chrome.mjs';

export const near = (a, b, tolerance = 0.6) => Math.abs(a - b) < tolerance;
function whole(strip) {
  if (!strip) return false;
  return strip.cells.every((c) => {
    const left = Math.max(c.rect.x, strip.rect.x),
      right = Math.min(c.rect.x + c.rect.width, strip.rect.x + strip.clientWidth);
    return right <= left + 0.6 || near(right - left, c.rect.width);
  });
}
export function lookScenarios(c, e, add) {
  for (const flavor of ['overlay', 'popup'])
    for (const width of [1440, 600, 500])
      for (const textSize of ['default', 'large']) {
        const id = `9-geometry-${flavor}-${width}-${textSize}`;
        add(
          id,
          `${flavor === 'overlay' && width === 500 ? '454 / 436' : '542 / 524'} px panel / strip, whole cells at both ends, ${textSize === 'large' ? 40 : 32} px rows (AC-25; C-WIN-16, C-SET-09)`,
          async () => {
            const h = await c.open(flavor, { width, textSize });
            // The popup shell is visible before .shown. Wait for the list and its renderer driven open motion.
            const start = await until(async () => {
              const x = await c.inspect(h);
              return x.class?.split(' ').includes('shown') && !x.animations.length ? x : null;
            });
            await c.key(h, 'ArrowLeft', HELD.modifier);
            const end = await until(async () => {
              const x = await c.inspect(h);
              return x.strip?.cells.at(-1)?.selected ? x : null;
            });
            const artifact = await c.shot(h, `${id}-end.png`);
            await c.key(h, 'ArrowRight', HELD.modifier);
            const back = await until(async () => {
              const x = await c.inspect(h);
              return x.strip?.cells[0]?.selected ? x : null;
            });
            const panel = flavor === 'overlay' && width === 500 ? 454 : 542,
              strip = panel - 18;
            const pass =
              [start, end, back].every(
                (x) => near(x.rect.width, panel) && near(x.strip.rect.width, strip) && whole(x.strip),
              ) &&
              near(start.rows[0].rect.height, textSize === 'large' ? 40 : 32) &&
              near(start.strip.scrollLeft, 0) &&
              near(back.strip.scrollLeft, 0) &&
              near(end.strip.scrollLeft % 44, 0) &&
              end.strip.scrollLeft > 0;
            return {
              pass,
              measured: {
                start,
                end,
                back,
                whole: [start, end, back].map((x) => whole(x.strip)),
                expectedPanel: panel,
                expectedStrip: strip,
              },
              artifacts: [artifact],
            };
          },
        );
      }
  for (const theme of ['dark', 'light']) {
    add(
      `owner-settings-${theme}`,
      `Settings follows ${theme} Theme immediately; owner screenshot (AC-25; C-SET-06)`,
      async () => {
        await c.settings({ theme });
        const page = await c.browser.newPage();
        try {
          // Opposite emulated OS proves the explicit Theme setting owns the page.
          await page.emulateMediaFeatures([
            { name: 'prefers-color-scheme', value: theme === 'dark' ? 'light' : 'dark' },
          ]);
          await page.setViewport({ width: 1100, height: 1050 });
          await page.goto(c.extensionBase + c.manifest.options_ui.page);
          await page.waitForSelector('main');
          await pause(150);
          const measured = await page.evaluate(() => ({
            rootClass: document.documentElement.className,
            colorScheme: getComputedStyle(document.documentElement).colorScheme,
            background: getComputedStyle(document.body).backgroundColor,
            selects: document.querySelectorAll('select').length,
            fieldsets: document.querySelectorAll('fieldset').length,
          }));
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
          await pause(40);
          measured.screenshotOsTheme = theme;
          const artifact = `settings-${theme}.png`;
          await page.screenshot({ path: path.join(e.out, artifact), fullPage: true });
          return {
            pass: measured.rootClass.split(' ').includes(theme) && measured.colorScheme === theme,
            measured,
            artifacts: [artifact],
          };
        } finally {
          await page.close();
        }
      },
    );
    add(
      `owner-overlay-glass-${theme}`,
      `Overlay has ${theme === 'dark' ? '84' : '86'}% tint, blur(30px) saturate(160%); owner screenshot (AC-25; C-HOLD-26)`,
      async () => {
        const h = await c.open('overlay', { theme });
        await pause(120);
        const measured = await c.inspect(h),
          artifact = await c.shot(h, `overlay-${theme}-busy.png`);
        return {
          pass:
            /blur\(30px\)/.test(measured.backdrop) &&
            /saturate\(1\.6\)|saturate\(160%\)/.test(measured.backdrop) &&
            measured.background.includes(theme === 'dark' ? '0.84' : '0.86'),
          measured,
          artifacts: [artifact],
        };
      },
    );
  }
  add(
    '9-popup-solid',
    'Popup stays solid with no visible border, shadow or backdrop filter (AC-25; C-HOLD-26)',
    async () => {
      const h = await c.open('popup');
      await pause(120);
      const measured = await c.inspect(h);
      return {
        pass: measured.backdrop === 'none' && measured.shadow === 'none' && !/rgba/.test(measured.background),
        measured,
        artifacts: [await c.shot(h, 'popup-solid.png')],
      };
    },
  );
  for (const flavor of ['overlay', 'popup'])
    add(
      `sound-${flavor}`,
      'Synthetic audible browser fact produces a 14 px display only speaker and Playing sound in hold and search names (AC-22, AC-23; C-HOLD-25)',
      async () => {
        const naturalAudible = await c.workerEval(
          `(async()=>{const t=await chrome.tabs.get(${c.audio.id});return t.audible})()`,
        );
        await c.scenario.audible();
        const h = await c.open(flavor);
        await pause(110);
        const hold = await c.inspect(h);
        await c.key(h, 'f', HELD.modifier);
        await pause(120);
        const search = await c.inspect(h);
        const sound = (x) => x.rows.find((r) => r.title === 'H1 Audio');
        return {
          pass: [hold, search].every(
            (x) =>
              sound(x)?.sound &&
              sound(x).label.includes('Playing sound') &&
              sound(x).svgs.some((s) => near(s.width, 14) && s.hidden === 'true') &&
              x.rows.filter((r) => r.title !== 'H1 Audio').every((r) => !r.sound),
          ),
          measured: {
            naturalAudible,
            syntheticAudible: true,
            fixture: 'Populated chrome.windows.getAll result changes only audible; restored after scenario',
            hold,
            search,
          },
        };
      },
    );
}
