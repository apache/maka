/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { Session, WebContents } from 'electron';

export interface MainWindowPermissionCheck {
  ownerMatches: boolean;
  rendererUrlMatches: boolean;
  permission: string;
  isMainFrame: boolean;
  mediaType?: string;
  voiceArmed?: boolean;
}

export interface MainWindowPermissionRequest {
  ownerMatches: boolean;
  rendererUrlMatches: boolean;
  permission: string;
  isMainFrame: boolean;
  mediaTypes?: readonly string[];
  voiceArmed?: boolean;
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
 * too so the exact version never regresses copy). Audio capture additionally requires
 * an explicitly armed voice call; camera capture is never granted.
 */
function isAllowedPermission(permission: string): boolean {
  return (
    permission === 'clipboard-sanitized-write'
    || permission === 'clipboard-write'
  );
}

export function allowsMainWindowPermissionCheck(input: MainWindowPermissionCheck): boolean {
  if (!(input.ownerMatches && input.rendererUrlMatches && input.isMainFrame)) return false;
  return isAllowedPermission(input.permission) || (input.voiceArmed === true && input.permission === 'media' && input.mediaType === 'audio');
}

export function allowsMainWindowPermissionRequest(input: MainWindowPermissionRequest): boolean {
  if (!(input.ownerMatches && input.rendererUrlMatches && input.isMainFrame)) return false;
  return isAllowedPermission(input.permission) || (input.voiceArmed === true && input.permission === 'media' && input.mediaTypes?.length === 1 && input.mediaTypes[0] === 'audio');
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

const voiceOwners = new WeakSet<WebContents>();
export function armVoiceMicrophone(owner: WebContents, enabled: boolean): void {
  if (enabled) voiceOwners.add(owner);
  else voiceOwners.delete(owner);
}

const trustedOwners = new WeakMap<Session, Map<WebContents, string>>();

export function installMainWindowPermissionPolicy(
  owner: WebContents,
  trustedRendererUrl: string,
): void {
  const rendererSession = owner.session;
  const existing = trustedOwners.get(rendererSession);
  const owners = existing ?? new Map<WebContents, string>();
  owners.set(owner, trustedRendererUrl);
  owner.once('destroyed', () => owners.delete(owner));
  if (existing) return;
  trustedOwners.set(rendererSession, owners);
  rendererSession.setPermissionCheckHandler((requester, permission, _origin, details) =>
    allowsMainWindowPermissionCheck({
      ownerMatches: !!requester && owners.has(requester),
      rendererUrlMatches: matchesTrustedRendererUrl(
        details.requestingUrl ?? '',
        requester ? (owners.get(requester) ?? '') : '',
      ),
      permission,
      isMainFrame: details.isMainFrame,
      mediaType: details.mediaType,
      voiceArmed: !!requester && voiceOwners.has(requester),
    }));
  rendererSession.setPermissionRequestHandler((requester, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(allowsMainWindowPermissionRequest({
      ownerMatches: !!requester && owners.has(requester),
      rendererUrlMatches: matchesTrustedRendererUrl(details.requestingUrl, requester ? (owners.get(requester) ?? '') : ''),
      permission,
      isMainFrame: details.isMainFrame,
      mediaTypes,
      voiceArmed: !!requester && voiceOwners.has(requester),
    }));
  });
}
