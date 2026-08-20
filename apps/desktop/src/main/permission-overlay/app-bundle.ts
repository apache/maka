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
 * Under `MAKA_DEV_TCC=1` the same walk lands on the generated, signed
 * `Maka Dev.app`, which is also the TCC identity the user grants. Under a plain
 * `electron .` it lands on the npm `Electron.app`, which is the honest answer
 * for that setup even though macOS will not keep a grant for it. The only
 * genuinely unresolvable case is a layout where the walk doesn't end in `.app`
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

interface NativeBundleIconOptions {
  size: 'normal';
}

// Electron's `large` file-icon size is unsupported on macOS and can terminate
// the packaged process before the promise settles. Both packaged icon reads
// must use `normal`; callers may resize the decorative image afterwards.
const NATIVE_BUNDLE_ICON_OPTIONS: NativeBundleIconOptions = { size: 'normal' };

/**
 * Reading a bundle icon is presentation-only. The original unpackaged npm
 * Electron runtime could terminate natively while macOS resolved its bundle
 * icon, before the returned promise settled. Keep native icon loading for
 * packaged Maka.app builds and let the signed Maka Dev workflow use an empty
 * drag image instead.
 */
export async function loadNativeBundleIcon<T>(
  isPackaged: boolean,
  load: (options: NativeBundleIconOptions) => Promise<T>,
): Promise<T | null> {
  if (!isPackaged) return null;
  try {
    return await load(NATIVE_BUNDLE_ICON_OPTIONS);
  } catch {
    return null;
  }
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
