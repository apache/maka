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
 * The product renderer only needs one Chromium permission: microphone audio
 * for the local Voice capture check. Keep this policy explicit because
 * Electron otherwise leaves a session's permission behavior to permissive
 * defaults, and the default session is also shared by auxiliary windows.
 */
export function allowsMainWindowPermissionCheck(input: MainWindowPermissionCheck): boolean {
  return (
    input.ownerMatches
    && input.rendererUrlMatches
    && input.isMainFrame
    && input.permission === 'media'
    && input.mediaType === 'audio'
  );
}

export function allowsMainWindowPermissionRequest(input: MainWindowPermissionRequest): boolean {
  return (
    input.ownerMatches
    && input.rendererUrlMatches
    && input.isMainFrame
    && input.permission === 'media'
    && input.mediaTypes?.length === 1
    && input.mediaTypes[0] === 'audio'
  );
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
