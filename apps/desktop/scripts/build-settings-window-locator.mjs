// Compile the settings-window locator into apps/desktop/resources/native.
//
// Build-time, not run-time. Alma compiles the equivalent Swift with
// `swiftc` on the user's machine at first use, which trades a build step
// for a hard runtime dependency on the Xcode Command Line Tools — absent
// on most non-developer Macs, and its failure path is a console warning
// nobody sees. Doing it here means the risk lands on a build machine that
// either has the toolchain or doesn't, visibly.
//
// Missing toolchain is NOT a build failure: the locator is a progressive
// enhancement. Without the binary the permission card still opens, still
// drags, still detects the grant — it just anchors to the cursor instead
// of docking to the Settings window. So we warn loudly and continue,
// rather than making a macOS-only nicety a hard gate on `npm run build`.

import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(desktopRoot, 'native', 'settings-window-locator', 'locator.swift');
const outDir = resolve(desktopRoot, 'resources', 'native');
const target = resolve(outDir, 'settings-window-locator');

/** Both slices, so the artifact matches the universal cua-driver already pinned. */
const ARCHS = [
  { arch: 'arm64', triple: 'arm64-apple-macos13' },
  { arch: 'x86_64', triple: 'x86_64-apple-macos13' },
];

function skip(reason) {
  console.warn(
    `[settings-window-locator] SKIPPED — ${reason}.\n`
    + '  The permission card will fall back to cursor anchoring instead of\n'
    + '  docking to the System Settings window. This is a degraded but\n'
    + '  working state, not a broken build.',
  );
}

if (process.platform !== 'darwin') {
  skip('not macOS');
  process.exit(0);
}

const swiftc = await run('/usr/bin/xcrun', ['--find', 'swiftc']).catch(() => null);
if (!swiftc) {
  skip('swiftc not found (install the Xcode Command Line Tools)');
  process.exit(0);
}

const swiftcPath = swiftc.stdout.trim();

// An explicit -target needs an explicit -sdk: without it swiftc looks for
// the standard library under the *host* triple and fails with
// "unable to load standard library for target".
const sdk = await run('/usr/bin/xcrun', ['--show-sdk-path']).catch(() => null);
if (!sdk) {
  skip('no macOS SDK found (xcrun --show-sdk-path failed)');
  process.exit(0);
}
const sdkPath = sdk.stdout.trim();

await mkdir(outDir, { recursive: true });

const slices = [];
try {
  for (const { arch, triple } of ARCHS) {
    const slice = resolve(outDir, `settings-window-locator.${arch}`);
    await run(swiftcPath, ['-O', '-target', triple, '-sdk', sdkPath, '-o', slice, source]);
    slices.push(slice);
  }
  // `lipo -create` even for one slice keeps the output shape identical.
  await run('/usr/bin/lipo', ['-create', ...slices, '-output', target]);
  const built = await stat(target);
  console.log(
    `settings-window-locator built → ${target} (${(built.size / 1024).toFixed(0)} KB, ${ARCHS.map((a) => a.arch).join(' + ')})`,
  );
} catch (error) {
  skip(`compile failed: ${error?.stderr?.trim?.() || error?.message || error}`);
} finally {
  // The per-arch slices are inputs, not artifacts; leaving them behind
  // would ship two extra copies inside the app bundle.
  await Promise.all(slices.map((slice) => rm(slice, { force: true })));
}
