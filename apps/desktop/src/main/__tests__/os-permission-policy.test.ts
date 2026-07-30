import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapMediaAccessStatus,
  mediaPermissionActions,
  planPermissionRequest,
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
    assert.equal(supportsMediaPermissionProbe('microphone', 'darwin'), true);
    assert.equal(supportsMediaPermissionProbe('microphone', 'win32'), true);
    assert.equal(supportsMediaPermissionProbe('microphone', 'linux'), false);
  });

  it('never advertises a request button that the main-process action cannot perform', () => {
    assert.deepEqual(mediaPermissionActions({
      id: 'microphone',
      platform: 'darwin',
      status: 'not_determined',
    }), { canOpenSettings: true, canRequest: true });
    assert.deepEqual(mediaPermissionActions({
      id: 'microphone',
      platform: 'win32',
      status: 'not_determined',
    }), { canOpenSettings: false, canRequest: false });
    assert.deepEqual(mediaPermissionActions({
      id: 'microphone',
      platform: 'linux',
      status: 'unsupported',
    }), { canOpenSettings: false, canRequest: false });
  });

  it('routes stale denied requests to System Settings and never fakes notification success', () => {
    assert.equal(planPermissionRequest({
      id: 'microphone',
      platform: 'darwin',
      microphoneStatus: 'not-determined',
    }), 'request_microphone');
    assert.equal(planPermissionRequest({
      id: 'microphone',
      platform: 'darwin',
      microphoneStatus: 'denied',
    }), 'open_settings');
    assert.equal(planPermissionRequest({
      id: 'microphone',
      platform: 'darwin',
      microphoneStatus: 'restricted',
    }), 'open_settings');
    assert.equal(planPermissionRequest({
      id: 'microphone',
      platform: 'darwin',
      microphoneStatus: 'unknown',
    }), 'open_settings');
    assert.equal(planPermissionRequest({
      id: 'microphone',
      platform: 'darwin',
      microphoneStatus: 'granted',
    }), 'already_granted');
    assert.equal(planPermissionRequest({
      id: 'notifications',
      platform: 'darwin',
    }), 'open_settings');
    assert.equal(planPermissionRequest({
      id: 'microphone',
      platform: 'linux',
    }), 'unsupported_platform');
  });
});
