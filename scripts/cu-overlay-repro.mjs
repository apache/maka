// Put both Computer Use overlays on the screen, deterministically, with no
// model and no target application involved.
//
// The scenario harness can only show these two windows as a side effect of a
// real turn, and it shows the mirror only when a dispatch succeeds — so a
// visual change to either overlay cannot be checked without also winning a
// model run. This drives the two controllers directly instead: the cursor
// overlay is asked to fly, and the mirror is handed a synthetic frame, which is
// exactly what `withComputerUsePip` hands it after a real action.
//
// Independent witness: the windows are read back out of the window server with
// CGWindowListCopyWindowInfo, not out of Electron. A window Electron believes
// it created and a window that is actually on screen are the same object in
// `BrowserWindow.getAllWindows()` and different objects here.
//
//   npx electron scripts/cu-overlay-repro.mjs
//
// Add `--hold` to leave both overlays up until Ctrl-C, for looking at them.
import { app, screen } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'apps', 'desktop', 'dist');
const overlayDist = join(dist, 'overlay');
const HOLD = process.argv.includes('--hold');

const { createCursorOverlayController } = await import(
  join(dist, 'main', 'computer-use', 'cursor-overlay-window.js')
);
const { createComputerUsePipController } = await import(
  join(dist, 'main', 'computer-use', 'pip-window.js')
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every on-screen window this process owns, read from the window server.
 *
 * `kCGWindowListOptionOnScreenOnly` is the point: a window that exists but was
 * never shown does not appear here, which is the difference the app's own log
 * cannot report.
 */
function onScreenWindows(pid) {
  const dir = mkdtempSync(join(tmpdir(), 'cu-overlay-repro-'));
  const src = join(dir, 'probe.swift');
  writeFileSync(
    src,
    `import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var out: [[String: Any]] = []
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid {
  var row: [String: Any] = [:]
  row["number"] = w[kCGWindowNumber as String] ?? 0
  row["name"] = w[kCGWindowName as String] ?? ""
  row["layer"] = w[kCGWindowLayer as String] ?? 0
  row["alpha"] = w[kCGWindowAlpha as String] ?? 0
  if let b = w[kCGWindowBounds as String] as? [String: Any] { row["bounds"] = b }
  out.append(row)
}
let data = try JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
`,
    'utf8',
  );
  return JSON.parse(
    execFileSync('swift', [src, String(pid)], { encoding: 'utf8', maxBuffer: 4 << 20 }),
  );
}

/** A frame to mirror, so the run needs no screen recording and no target app. */
function syntheticFrame(width, height) {
  const { nativeImage } = require('electron');
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const band = Math.floor((y / height) * 6);
      bytes[i] = band % 2 === 0 ? 0x2a : 0x8a; // B
      bytes[i + 1] = 0x3a;
      bytes[i + 2] = band % 2 === 0 ? 0x8a : 0x2a; // R
      bytes[i + 3] = 0xff;
    }
  }
  return nativeImage.createFromBuffer(bytes, { width, height }).toPNG().toString('base64');
}

const require = (await import('node:module')).createRequire(import.meta.url);

app.on('window-all-closed', () => {});

// A window that never finishes loading never shows itself, and both overlays
// show themselves from `did-finish-load`. Report the load rather than leaving
// "never appeared" to cover both "was never created" and "was created and died
// mid-load", which are different bugs with different fixes.
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('did-fail-load', (_ev, code, desc, url) =>
    console.log(`did-fail-load ${w.id} ${code} ${desc} ${url}`),
  );
  w.webContents.on('did-finish-load', () => console.log(`did-finish-load ${w.id}`));
});

app.whenReady().then(async () => {
  const sessionId = 'overlay-repro';
  const cursor = createCursorOverlayController({
    preloadPath: join(overlayDist, 'cursor-overlay-preload.cjs'),
    htmlPath: join(overlayDist, 'cursor-overlay.html'),
  });
  const pip = createComputerUsePipController({
    preloadPath: join(overlayDist, 'pip-preload.cjs'),
    htmlPath: join(overlayDist, 'pip.html'),
    cursorPoint: () => screen.getCursorScreenPoint(),
    workAreaFor: (rect) => screen.getDisplayMatching(rect).workArea,
  });

  // The cursor: exactly what the overlay hook does for a coordinate action.
  const work = screen.getPrimaryDisplay().workArea;
  cursor.ensure(sessionId);
  cursor.move({
    actionId: 'repro-1',
    sessionId,
    screenX: Math.round(work.x + work.width / 2),
    screenY: Math.round(work.y + work.height / 2),
    kind: 'click',
    instant: false,
  });

  // The mirror: exactly what `withComputerUsePip` does with a dispatch result
  // that carried a screenshot. Portrait, so a wrong aspect is obvious.
  const widthPx = 560;
  const heightPx = 880;
  pip.present({
    sessionId,
    base64: syntheticFrame(widthPx, heightPx),
    mimeType: 'image/png',
    widthPx,
    heightPx,
    title: 'overlay repro',
  });
  pip.setCursor({ sessionId, x: widthPx / 2, y: heightPx / 3 });

  // Both windows load their HTML before they show themselves, so the witness
  // has to be taken after the load, not after the call.
  await sleep(2500);

  const { BrowserWindow } = require('electron');
  console.log(
    'electron windows:',
    JSON.stringify(
      BrowserWindow.getAllWindows().map((w) => ({
        id: w.id,
        url: w.webContents.getURL(),
        visible: w.isVisible(),
        bounds: w.getBounds(),
      })),
    ),
  );
  const windows = onScreenWindows(process.pid);
  console.log(JSON.stringify(windows, null, 2));
  const sized = windows.filter((w) => (w.bounds?.Width ?? 0) > 0 && (w.bounds?.Height ?? 0) > 0);
  const mirror = sized.find(
    (w) => w.bounds.Width <= 400 && w.bounds.Height <= 400 && w.bounds.Width > 60,
  );
  const overlay = sized.find((w) => w.bounds.Width > 1000);
  console.log(`\ncursor overlay on screen: ${overlay ? 'yes' : 'NO'}`);
  console.log(
    `mirror on screen: ${mirror ? `yes ${mirror.bounds.Width}x${mirror.bounds.Height}` : 'NO'}`,
  );

  if (HOLD) {
    console.log('\nholding — Ctrl-C to quit');
    return;
  }
  cursor.destroyAll();
  pip.destroyAll();
  app.exit(overlay && mirror ? 0 : 1);
});
