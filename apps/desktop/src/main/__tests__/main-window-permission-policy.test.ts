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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WebContents } from 'electron';
import {
  allowsMainWindowPermissionCheck,
  allowsMainWindowPermissionRequest,
  installMainWindowPermissionPolicy,
  matchesTrustedRendererUrl,
} from '../main-window-permission-policy.js';

describe('main window Chromium permission policy', () => {
  it('allows top-level clipboard writes from the product renderer', () => {
    for (const permission of ['clipboard-sanitized-write', 'clipboard-write']) {
      assert.equal(allowsMainWindowPermissionCheck({
        ownerMatches: true,
        rendererUrlMatches: true,
        permission,
        isMainFrame: true,
      }), true);
      assert.equal(allowsMainWindowPermissionRequest({
        ownerMatches: true,
        rendererUrlMatches: true,
        permission,
        isMainFrame: true,
      }), true);
    }
  });

  it('denies media, subframes, auxiliary windows, and unrelated permissions', () => {
    assert.equal(allowsMainWindowPermissionCheck({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'media',
      isMainFrame: true,
      mediaType: 'audio',
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'media',
      isMainFrame: true,
      mediaTypes: ['audio'],
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'media',
      isMainFrame: true,
      mediaTypes: ['audio', 'video'],
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'clipboard-sanitized-write',
      isMainFrame: false,
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: false,
      rendererUrlMatches: true,
      permission: 'clipboard-write',
      isMainFrame: true,
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: false,
      permission: 'clipboard-write',
      isMainFrame: true,
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'notifications',
      isMainFrame: true,
    }), false);
  });

  it('keeps clipboard writes gated to the trusted top-level renderer frame', () => {
    // Wrong frame.
    assert.equal(allowsMainWindowPermissionCheck({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'clipboard-sanitized-write',
      isMainFrame: false,
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'clipboard-sanitized-write',
      isMainFrame: false,
    }), false);
    // Not our window.
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: false,
      rendererUrlMatches: true,
      permission: 'clipboard-write',
      isMainFrame: true,
    }), false);
    // Untrusted URL.
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: false,
      permission: 'clipboard-write',
      isMainFrame: true,
    }), false);
    // Reading from the clipboard stays denied.
    assert.equal(allowsMainWindowPermissionCheck({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'clipboard-read',
      isMainFrame: true,
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'clipboard-read',
      isMainFrame: true,
    }), false);
  });

  it('trusts the dev origin and exact packaged entry without trusting arbitrary files', () => {
    assert.equal(
      matchesTrustedRendererUrl('http://localhost:5173/settings', 'http://localhost:5173/'),
      true,
    );
    assert.equal(
      matchesTrustedRendererUrl('https://example.com/', 'http://localhost:5173/'),
      false,
    );
    assert.equal(
      matchesTrustedRendererUrl(
        'file:///Applications/Maka.app/Contents/Resources/app.asar/apps/desktop/dist-renderer/index.html#settings',
        'file:///Applications/Maka.app/Contents/Resources/app.asar/apps/desktop/dist-renderer/index.html',
      ),
      true,
    );
    assert.equal(
      matchesTrustedRendererUrl(
        'file:///Users/example/Downloads/untrusted.html',
        'file:///Applications/Maka.app/Contents/Resources/app.asar/apps/desktop/dist-renderer/index.html',
      ),
      false,
    );
  });

  it('installs both Electron handlers on the renderer session', () => {
    type CheckHandler = (
      requester: WebContents | null,
      permission: string,
      origin: string,
      details: { isMainFrame: boolean; mediaType?: string; requestingUrl?: string },
    ) => boolean;
    type RequestHandler = (
      requester: WebContents,
      permission: string,
      callback: (granted: boolean) => void,
      details: {
        isMainFrame: boolean;
        mediaTypes?: Array<'audio' | 'video'>;
        requestingUrl: string;
      },
    ) => void;
    let checkHandler: CheckHandler | undefined;
    let requestHandler: RequestHandler | undefined;
    const session = {
      setPermissionCheckHandler(handler: CheckHandler) {
        checkHandler = handler;
      },
      setPermissionRequestHandler(handler: RequestHandler) {
        requestHandler = handler;
      },
    };
    const owner = { session } as unknown as WebContents;
    const other = { session } as unknown as WebContents;

    installMainWindowPermissionPolicy(owner, 'file:///Applications/Maka.app/index.html');
    assert.ok(checkHandler);
    assert.ok(requestHandler);
    assert.equal(checkHandler(owner, 'media', 'file://', {
      isMainFrame: true,
      mediaType: 'audio',
      requestingUrl: 'file:///Applications/Maka.app/index.html',
    }), false);
    assert.equal(checkHandler(other, 'clipboard-sanitized-write', 'file://', {
      isMainFrame: true,
      requestingUrl: 'file:///Applications/Maka.app/index.html',
    }), false);
    assert.equal(checkHandler(owner, 'clipboard-sanitized-write', 'file://', {
      isMainFrame: true,
      requestingUrl: 'file:///Applications/Maka.app/index.html',
    }), true);

    let granted: boolean | undefined;
    requestHandler(owner, 'media', (next) => {
      granted = next;
    }, {
      isMainFrame: true,
      mediaTypes: ['audio'],
      requestingUrl: 'file:///Applications/Maka.app/index.html',
    });
    assert.equal(granted, false);

    let clipboardGranted: boolean | undefined;
    requestHandler(owner, 'clipboard-sanitized-write', (next) => {
      clipboardGranted = next;
    }, {
      isMainFrame: true,
      requestingUrl: 'file:///Applications/Maka.app/index.html',
    });
    assert.equal(clipboardGranted, true);
  });
});
