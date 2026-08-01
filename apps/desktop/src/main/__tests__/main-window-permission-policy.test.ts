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
  it('allows only top-level microphone audio from the product renderer', () => {
    assert.equal(allowsMainWindowPermissionCheck({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'media',
      isMainFrame: true,
      mediaType: 'audio',
    }), true);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'media',
      isMainFrame: true,
      mediaTypes: ['audio'],
    }), true);
  });

  it('denies camera, mixed media, subframes, auxiliary windows, and unrelated permissions', () => {
    assert.equal(allowsMainWindowPermissionCheck({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'media',
      isMainFrame: true,
      mediaType: 'video',
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
      permission: 'media',
      isMainFrame: false,
      mediaTypes: ['audio'],
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: false,
      rendererUrlMatches: true,
      permission: 'media',
      isMainFrame: true,
      mediaTypes: ['audio'],
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: false,
      permission: 'media',
      isMainFrame: true,
      mediaTypes: ['audio'],
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'notifications',
      isMainFrame: true,
    }), false);
    assert.equal(allowsMainWindowPermissionRequest({
      ownerMatches: true,
      rendererUrlMatches: true,
      permission: 'media',
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
    }), true);
    assert.equal(checkHandler(other, 'media', 'file://', {
      isMainFrame: true,
      mediaType: 'audio',
      requestingUrl: 'file:///Applications/Maka.app/index.html',
    }), false);

    let granted: boolean | undefined;
    requestHandler(owner, 'media', (next) => {
      granted = next;
    }, {
      isMainFrame: true,
      mediaTypes: ['audio'],
      requestingUrl: 'file:///Applications/Maka.app/index.html',
    });
    assert.equal(granted, true);
  });
});
