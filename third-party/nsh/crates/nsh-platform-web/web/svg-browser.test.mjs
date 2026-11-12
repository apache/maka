import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

let chromium;
try { execFileSync('chromium', ['--version'], { stdio: 'ignore' }); chromium = 'chromium'; } catch {}

// #1466: an `svg()` painting with `currentColor` draws in its text color, not black.
test('an svg() draws its currentColor in the color it is sent with', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-svg-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><div id="root"></div>
    <script type="module">
      import { Player } from '${module}';
      const markup = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='24' height='24'><rect width='24' height='24' fill='currentColor'/></svg>";
      const player = Object.create(Player.prototype);
      player.inlineImages = new Map(); player.svgTexts = new Map(); player.coloredSvgs = new Map();
      const uri = 'data:image/svg+xml;nsh-key=a';
      const blob = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
      player.inlineImages.set(uri, blob); player.svgTexts.set(blob, markup);
      const views = new Map();
      player.view = (id) => views.get(id);
      const mount = (id) => {
        const el = document.createElement('div'); el._id = id; el._events = new Set(); el._img = document.createElement('img');
        el.append(el._img); document.querySelector('#root').append(el); views.set(id, el); return el;
      };
      const pixel = async (img) => {
        await img.decode();
        const c = document.createElement('canvas'); c.width = c.height = 24;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        return Array.from(g.getImageData(12, 12, 1, 1).data.slice(0, 3)).join(',');
      };
      try {
        const red = mount(2), image = mount(3);
        player.op_img([, 2, uri, 'contain', null, 0, 0, '', 'rgb(224, 64, 64)']);
        player.op_img([, 3, uri, 'contain', null, 0, 0, '', null]);
        const got = [await pixel(red._img), await pixel(image._img)];
        // The color changes: a copy in the new one.
        player.op_img([, 2, uri, 'contain', null, 0, 0, '', '#4080e0']);
        got.push(await pixel(red._img));
        // An address the browser loads (an asset) is fetched once as text.
        const asset = mount(4);
        player.op_img([, 4, blob, 'contain', null, 0, 0, '', '#00ff00']);
        player.svgTexts.delete(blob); player.coloredSvgs.clear();
        player.op_img([, 4, blob, 'contain', null, 0, 0, '', '#00ff00']);
        await new Promise((r) => setTimeout(r, 100));
        got.push(await pixel(asset._img));
        document.body.dataset.result = got.join('|');
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=2000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], '224,64,64|0,0,0|64,128,224|0,255,0');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
