import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// The first Chromium-based browser found (`CHROME` names one).
const candidates = [
  process.env.CHROME,
  'chromium',
  'chromium-browser',
  'google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
let chromium;
for (const candidate of candidates) {
  try {
    execFileSync(candidate, ['--version'], { stdio: 'ignore' });
    chromium = candidate;
    break;
  } catch {}
}

test('tabular digits are measured as wide as the DOM draws them', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-text-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { measureNumericText };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>body { margin:0; }</style>
    <script type="module">
      import { measureNumericText } from '${module}';
      try {
        const font = '400 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        // A run as the mounter draws it: its class's font, then the variant.
        const drawn = (text, family = font) => {
          const run = document.createElement('span');
          run.style.cssText = 'position:absolute;white-space:pre;font:' + family + ';font-variant-numeric:tabular-nums';
          run.textContent = text;
          document.body.append(run);
          const width = run.getBoundingClientRect().width;
          run.remove();
          return width;
        };
        for (const text of ['530.92', '111.11', '1,234.56', 'Price']) {
          const measured = measureNumericText(font, 'tabular-nums', text);
          if (Math.abs(measured - drawn(text)) > 0.01) throw Error(text + ': measured ' + measured + ', drawn ' + drawn(text));
        }
        // Figures are measured character by character (the engine's
        // \`measured_by_char\` and \`figure_width\`): the characters'
        // sum with each adjacent pair's kerning is what the run draws. Arial
        // (Liberation Sans on Linux) has no \`tnum\` and kerns \`11\`.
        for (const family of [font, '400 20px Arial']) {
          const width = (text) => measureNumericText(family, 'tabular-nums', text);
          for (const text of ['530.92', '1,234.56', '-0.5%', '$1,111.11', '12:30']) {
            const chars = [...text];
            const sum = chars.reduce((w, c, i) => w + (i ? width(chars[i - 1] + c) - width(chars[i - 1]) : width(c)), 0);
            if (Math.abs(sum - drawn(text, family)) > 0.05) throw Error(family + ' ' + text + ': summed ' + sum + ', drawn ' + drawn(text, family));
          }
        }
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});


// On a 2x screen Chrome draws color emoji narrower than canvas measures
// them (14 against 18 px at 14px): the engine adds each emoji cluster's
// difference, measured in the DOM, to the canvas width (`emoji_excess`).
test('emoji are measured as wide as the DOM draws them on a 2x screen', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-text-emoji-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { measureNumericText };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><body><script type="module">
      import { measureNumericText } from '${module}';
      try {
        const font = '400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const canvas = new OffscreenCanvas(1, 1).getContext('2d');
        canvas.font = font;
        const drawn = (text) => {
          const run = document.createElement('span');
          run.style.cssText = 'position:absolute;white-space:pre;font:' + font;
          run.textContent = text;
          document.body.append(run);
          const width = run.getBoundingClientRect().width;
          run.remove();
          return width;
        };
        const clusters = (text) => [...new Intl.Segmenter().segment(text)].map((s) => s.segment);
        // The engine's css::is_emoji.
        const emoji = (cluster) => [...cluster].some((c) => c.codePointAt(0) > 0x7f && (/\\p{Emoji}/u.test(c) || c === '\\u{FE0F}' || c === '\\u{20E3}'));
        for (const text of ['🤩'.repeat(22), 'abc🤩def', '👍🏻 1️⃣ ⌚ 🇨🇳 ⭐ ok', 'a👨‍👩‍👧‍👦b ❤️ ☝✌✍⛹ 中文 ไทย']) {
          const measured = canvas.measureText(text).width + clusters(text)
            .filter(emoji)
            .reduce((w, c) => w + measureNumericText(font, 'normal', c) - canvas.measureText(c).width, 0);
          if (Math.abs(measured - drawn(text)) > 0.05) throw Error(text + ': measured ' + measured + ', drawn ' + drawn(text));
        }
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--force-device-scale-factor=2',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cluster boxes follow bidi reordering and preserve measurement styles', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-text-bidi-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { textClusterBoxes, measureNumericText };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><body><script type="module">
      import { textClusterBoxes, measureNumericText } from '${module}';
      try {
        const font = '400 20px Arial';
        const near = (a,b) => { if (Math.abs(a-b)>0.05) throw Error(a+' != '+b); };
        const rtl = textClusterBoxes(font, '', 0, 'אב', [[0,1],[1,2]]);
        if (!(rtl[0][0] > rtl[1][0])) throw Error('RTL clusters are reversed: '+JSON.stringify(rtl));
        const mixed = textClusterBoxes(font, '', 0, 'abc אבג xyz', [[0,4],[4,5],[5,7]]);
        if (!(mixed[0][1] < mixed[1][0] && mixed[2][1] <= mixed[1][0] + 0.05)) throw Error('bidi selection must have a gap');
        const before = measureNumericText(font, 'tabular-nums', '111');
        textClusterBoxes(font, '', 4, 'אב', [[0,1],[1,2]]);
        near(measureNumericText(font, 'tabular-nums', '111'), before);
        const spaced = textClusterBoxes(font, 'tabular-nums', 3, '123', [[0,1],[1,2],[2,3]]);
        const run = document.createElement('span');
        run.style.cssText = 'position:absolute;white-space:pre;font:'+font+';font-variant-numeric:tabular-nums;letter-spacing:3px';
        run.textContent = '123'; document.body.append(run);
        near(spaced[2][1], run.getBoundingClientRect().width);
        document.body.dataset.result = 'passed';
      } catch(e) { document.body.dataset.result = 'failed: '+e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a link stays in its run, drawn in its text\'s bidi order', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-text-link-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { fillRun };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><body><script type="module">
      import { fillRun } from '${module}';
      try {
        const near = (a,b,what) => { if (Math.abs(a-b)>0.5) throw Error(what+': '+a+' != '+b); };
        const run = (parts) => {
          const el = document.createElement('span');
          el.style.cssText = 'position:absolute;left:0;top:0;white-space:pre;font:400 20px Arial';
          fillRun(el, 'אב גד', parts, [{ node: 3 }]);
          document.body.append(el);
          return el;
        };
        const box = (el, from, to) => {
          const r = document.createRange();
          r.setStart(el.firstChild, from);
          r.setEnd(el.firstChild, to);
          return r.getBoundingClientRect();
        };
        // The same text without a link, and with its second word one,
        // styled as the rest (one run).
        const plain = run(null);
        const linked = run([[3, 5, 0]]);
        const link = linked.querySelector('span');
        if (link?._link?.node !== 3 || link.textContent !== 'גד') throw Error('the link has no span of its own');
        near(linked.getBoundingClientRect().width, plain.getBoundingClientRect().width, 'run width');
        near(link.getBoundingClientRect().left, box(plain, 3, 5).left, 'link left');
        near(link.getBoundingClientRect().width, box(plain, 3, 5).width, 'link width');
        // Right to left: the second word is drawn left of the first.
        if (!(link.getBoundingClientRect().right <= box(plain, 0, 2).left + 0.5)) throw Error('the words are not right to left');
        document.body.dataset.result = 'passed';
      } catch(e) { document.body.dataset.result = 'failed: '+e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a text of one color transitions it on its element, from the color on screen', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-text-color-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { setTextColor };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
    <style>.t { transition-property: color; transition-duration: 1000ms; transition-timing-function: linear; }</style>
    <body><script type="module">
      import { setTextColor } from '${module}';
      try {
        const el = document.createElement('div');
        el.className = 't';
        // A run as op_t makes it: its class has no color of its own.
        const run = document.createElement('span');
        run.textContent = 'Tab';
        el.append(run);
        document.body.append(el);
        const rgb = () => getComputedStyle(run).color.match(/[\\d.]+/g).slice(0, 3).map(Number);
        const near = (want, what) => {
          const got = rgb();
          if (got.some((v, i) => Math.abs(v - want[i]) > 1)) throw Error(what + ': ' + got + ' != ' + want);
        };
        const transition = () => el.getAnimations().filter((a) => a.transitionProperty === 'color');
        // The first color: at once.
        setTextColor(el, 'rgb(255, 0, 0)');
        near([255, 0, 0], 'first color');
        if (transition().length) throw Error('the first color transitioned');
        // A new one: half-way after half the duration, in the run made before.
        setTextColor(el, 'rgb(0, 0, 255)');
        let [a] = transition();
        if (!a) throw Error('no transition of color');
        a.pause();
        a.currentTime = 500;
        near([128, 0, 128], 'half-way');
        // A run made again mid-way inherits the color on screen.
        const again = document.createElement('span');
        again.textContent = 'Tab';
        run.replaceWith(again);
        if (getComputedStyle(again).color !== getComputedStyle(el).color) throw Error('a new run did not inherit');
        el.replaceChildren(run);
        // Back to red mid-way: from where it is.
        setTextColor(el, 'rgb(255, 0, 0)');
        [a] = transition();
        a.pause();
        a.currentTime = 0;
        near([128, 0, 128], 'reversed');
        // Several colors (the runs carry theirs), then one: at once.
        setTextColor(el, null);
        setTextColor(el, 'rgb(0, 128, 0)');
        if (transition().length) throw Error('a color after several transitioned');
        near([0, 128, 0], 'after several');
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the characters lines broke at stand between the runs, read but never drawn', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-text-breaks-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
    <body><script type="module">
      import { Player } from '${module}';
      try {
        const player = Object.create(Player.prototype);
        player.styleClass = () => '';
        // A text of three lines as fillRun leaves them: one span per run.
        const el = document.createElement('div');
        el.style.cssText = 'position:absolute;left:0;top:0;font:400 20px Arial';
        for (const text of ['it now', 'brings', 'more']) {
          const span = document.createElement('span');
          span.className = 'nsh-run';
          span.style.cssText = 'position:absolute;white-space:pre';
          span.textContent = text;
          el.append(span);
        }
        document.body.append(el);
        // [x, y, text, style, start, parts, after]: a soft break ate a
        // space, a hard break's newline; the last line broke at nothing.
        const runs = [[0, 0, 'it now', 0, 0, null, ' '], [0, 24, 'brings', 0, 7, null, '\\n'], [0, 48, 'more', 0, 14, null, null]];
        const lefts = () => [...el.children].map((s) => s.getBoundingClientRect().left + ',' + s.getBoundingClientRect().top).join(' ');
        if (!player.updateRuns(el, 0, 0, runs, [{}], null, null)) throw Error('the runs were made again');
        const placed = lefts();
        if (el.textContent !== 'it now brings\\nmore') throw Error('textContent: ' + JSON.stringify(el.textContent));
        // Laid out again: the breaks are not added twice.
        player.updateRuns(el, 0, 0, runs, [{}], null, null);
        if (el.textContent !== 'it now brings\\nmore') throw Error('again: ' + JSON.stringify(el.textContent));
        // Nothing moved, and the whitespace takes no room.
        if (lefts() !== placed) throw Error('the runs moved');
        if (el.getBoundingClientRect().height !== 0) throw Error('the breaks take room');
        // A line that no longer breaks drops its character.
        runs[0][6] = null;
        player.updateRuns(el, 0, 0, runs, [{}], null, null);
        if (el.textContent !== 'it nowbrings\\nmore') throw Error('dropped: ' + JSON.stringify(el.textContent));
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
