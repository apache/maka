import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapMediaAccessStatus,
  mediaPermissionActions,
  planPermissionRequest,
  requestScreenCaptureConsent,
  supportsMediaPermissionProbe,
} from '../os-permission-policy.js';

describe('OS permission platform policy', () => {
  it('normalizes Electron media states without treating restrictions as requestable', () => {
    assert.equal(mapMediaAccessStatus('granted'), 'granted');
    assert.equal(mapMediaAccessStatus('not-determined'), 'not_determined');
    assert.equal(mapMediaAccessStatus('denied'), 'denied');
    assert.equal(mapMediaAccessStatus('restricted'), 'denied');
    assert.equal(mapMediaAccessStatus('unexpected'), 'unknown');
  });

  it('only probes media statuses on platforms where Electron exposes them', () => {
    assert.equal(supportsMediaPermissionProbe('screen_recording', 'darwin'), true);
    assert.equal(supportsMediaPermissionProbe('screen_recording', 'win32'), false);
  });

  it('advertises only request actions the main process can perform', () => {
    assert.deepEqual(mediaPermissionActions({
      id: 'screen_recording',
      platform: 'darwin',
      status: 'denied',
    }), { canOpenSettings: true, canRequest: true });
    assert.deepEqual(mediaPermissionActions({
      id: 'screen_recording',
      platform: 'darwin',
      status: 'granted',
    }), { canOpenSettings: true, canRequest: false });
    assert.deepEqual(mediaPermissionActions({
      id: 'screen_recording',
      platform: 'win32',
      status: 'not_determined',
    }), { canOpenSettings: false, canRequest: false });
  });

  it('routes stale denied requests to System Settings and never fakes notification success', () => {
    assert.equal(planPermissionRequest({
      id: 'screen_recording',
      platform: 'darwin',
      screenStatus: 'denied',
    }), 'request_screen_capture');
    assert.equal(planPermissionRequest({
      id: 'screen_recording',
      platform: 'darwin',
      screenStatus: 'granted',
    }), 'already_granted');
    assert.equal(planPermissionRequest({
      id: 'notifications',
      platform: 'darwin',
    }), 'open_settings');
    assert.equal(planPermissionRequest({
      id: 'accessibility',
      platform: 'darwin',
    }), 'open_settings');
    assert.equal(planPermissionRequest({
      id: 'screen_recording',
      platform: 'linux',
    }), 'unsupported_platform');
  });

  it('attempts a real screen capture before deciding whether settings are needed', async () => {
    let captures = 0;
    assert.equal(await requestScreenCaptureConsent({
      capture: async () => { captures += 1; },
      status: () => 'denied',
    }), 'open_settings');
    assert.equal(captures, 1);
    assert.equal(await requestScreenCaptureConsent({
      capture: async () => { throw new Error('TCC denied'); },
      status: () => 'granted',
    }), 'granted');
  });
});
