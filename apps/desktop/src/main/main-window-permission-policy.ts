import type { WebContents } from 'electron';

export interface MainWindowPermissionCheck {
  ownerMatches: boolean;
  rendererUrlMatches: boolean;
  permission: string;
  isMainFrame: boolean;
  mediaType?: string;
}

export interface MainWindowPermissionRequest {
  ownerMatches: boolean;
  rendererUrlMatches: boolean;
  permission: string;
  isMainFrame: boolean;
  mediaTypes?: readonly string[];
}

/**
 * The product renderer needs clipboard writes so the code-block / message /
 * settings copy buttons (`navigator.clipboard.writeText`) can reach the OS
 * clipboard.
 *
 * Keep this policy explicit because Electron otherwise leaves a session's
 * permission behavior to permissive defaults, and the default session is also
 * shared by auxiliary windows. Clipboard write is granted only when
 * `navigator.clipboard.writeText` asks for it (Chromium reports the sanitized
 * text path as `clipboard-sanitized-write`; the unsanitized name is accepted
 * too so the exact version never regresses copy). Media capture is not granted.
 */
function isAllowedPermission(permission: string): boolean {
  return (
    permission === 'clipboard-sanitized-write'
    || permission === 'clipboard-write'
  );
}

export function allowsMainWindowPermissionCheck(input: MainWindowPermissionCheck): boolean {
  if (!(input.ownerMatches && input.rendererUrlMatches && input.isMainFrame)) return false;
  return isAllowedPermission(input.permission);
}

export function allowsMainWindowPermissionRequest(input: MainWindowPermissionRequest): boolean {
  if (!(input.ownerMatches && input.rendererUrlMatches && input.isMainFrame)) return false;
  return isAllowedPermission(input.permission);
}

/**
 * Dev serves the renderer over HTTP, where same-origin routes are trusted.
 * Packaged builds use file://, whose URL origin is always "null", so the
 * exact entry document path is the trust boundary there.
 */
export function matchesTrustedRendererUrl(
  requestingUrl: string,
  trustedRendererUrl: string,
): boolean {
  try {
    const requesting = new URL(requestingUrl);
    const trusted = new URL(trustedRendererUrl);
    if (trusted.protocol === 'file:') {
      return requesting.protocol === 'file:' && requesting.pathname === trusted.pathname;
    }
    return requesting.origin === trusted.origin;
  } catch {
    return false;
  }
}

export function installMainWindowPermissionPolicy(
  owner: WebContents,
  trustedRendererUrl: string,
): void {
  const rendererSession = owner.session;
  rendererSession.setPermissionCheckHandler((requester, permission, _origin, details) =>
    allowsMainWindowPermissionCheck({
      ownerMatches: requester === owner,
      rendererUrlMatches: matchesTrustedRendererUrl(
        details.requestingUrl ?? '',
        trustedRendererUrl,
      ),
      permission,
      isMainFrame: details.isMainFrame,
      mediaType: details.mediaType,
    }));
  rendererSession.setPermissionRequestHandler((requester, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(allowsMainWindowPermissionRequest({
      ownerMatches: requester === owner,
      rendererUrlMatches: matchesTrustedRendererUrl(details.requestingUrl, trustedRendererUrl),
      permission,
      isMainFrame: details.isMainFrame,
      mediaTypes,
    }));
  });
}
