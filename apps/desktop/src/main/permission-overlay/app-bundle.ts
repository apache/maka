/**
 * Resolving the `.app` bundle to drag into System Settings.
 *
 * macOS accepts an application bundle dropped onto a Privacy list, which
 * is the whole point of the drag-to-grant flow — but it accepts *only* a
 * real `.app`, so the path has to be exact. Electron gives us the
 * executable inside the bundle, three levels down:
 *
 *   /Applications/Maka.app/Contents/MacOS/Maka   <- app.getPath('exe')
 *   /Applications/Maka.app/Contents/MacOS
 *   /Applications/Maka.app/Contents
 *   /Applications/Maka.app                       <- what we drag
 *
 * Under `electron .` the same walk lands on `Electron.app`, which is
 * correct rather than a degradation: in dev the TCC identity really is
 * Electron, so that is the bundle the user must grant. The only genuinely
 * unresolvable case is a layout where the walk doesn't end in `.app`
 * (e.g. an unpacked CI tree), and the caller degrades explicitly there
 * instead of starting a drag that can never be accepted.
 *
 * Pure + injectable so the walk is testable without an Electron runtime.
 */

import { dirname } from 'node:path';

export type AppBundleResult =
  | { ok: true; bundlePath: string }
  | { ok: false; reason: 'not_darwin' | 'not_a_bundle'; executablePath: string };

export interface ResolveAppBundleDeps {
  executablePath: string;
  platform: NodeJS.Platform;
  exists(path: string): boolean;
}

export function resolveAppBundle(deps: ResolveAppBundleDeps): AppBundleResult {
  const { executablePath, platform, exists } = deps;
  if (platform !== 'darwin') {
    return { ok: false, reason: 'not_darwin', executablePath };
  }
  const bundlePath = dirname(dirname(dirname(executablePath)));
  if (!bundlePath.endsWith('.app') || !exists(bundlePath)) {
    return { ok: false, reason: 'not_a_bundle', executablePath };
  }
  return { ok: true, bundlePath };
}
