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
import { afterEach, test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { LocaleProvider, ToastProvider } from '@maka/ui';

import { RuntimeHostSettingsTarget } from '../../renderer/settings/runtime-host-settings-target.js';
import {
  useOAuthLoginFlow,
  type OAuthLoginFlowBridge,
  type OAuthLoginFlowController,
} from '../../renderer/settings/use-oauth-login-flow.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

function bridgeReporting(runtimeState: string): OAuthLoginFlowBridge {
  return {
    getAuthUrl: async () => ({ authRequestId: 'attempt-1', stateHint: 'ABCD-EFGH' }),
    openAuthUrl: async () => ({ ok: true as const }),
    completeAuthorization: async () => new Promise<never>(() => undefined),
    cancelAuthorization: async () => ({ ok: true as const }),
    getAccountState: async () => ({ runtimeState }),
    logout: async () => ({ ok: true as const }),
  };
}

// The hook reads locale, toast, and the selected Host from context; none of
// them participate in what these tests assert, so they are here only to let it
// mount at all.
function withSettingsContext(children: ReactNode): ReactNode {
  return createElement(LocaleProvider, {
    locale: 'zh' as const,
    children: createElement(ToastProvider, {
      children: createElement(RuntimeHostSettingsTarget, {
        host: { profileId: 'local', hostId: 'test-host' },
        children,
      }),
    }),
  });
}

async function mountFlow(
  bridge: OAuthLoginFlowBridge,
): Promise<() => OAuthLoginFlowController> {
  const { root } = installReactRenderer();
  let controller!: OAuthLoginFlowController;
  function Probe() {
    controller = useOAuthLoginFlow({
      bridge,
      display: { name: 'GitHub Copilot', shortName: 'GitHub Copilot' },
    });
    return null;
  }
  await act(async () => {
    root.render(withSettingsContext(createElement(Probe)));
  });
  return () => controller;
}

// The device grant outlives the surface that started it: the Host keeps
// polling, and a Settings close and reopen mounts a flow that never saw the
// attempt. Reported, so the local import route can refuse to commit over a
// login the user is still completing.
test('a mount adopts a device grant the Host is still polling', async () => {
  const flow = await mountFlow(bridgeReporting('authorizing'));

  assert.equal(flow().hostAttemptPending, true);
  // Not this surface's action: the labels and the shared guard stay untouched
  // so the sign-in that would supersede the stale attempt remains offered.
  assert.equal(flow().actionBusy, false);
  assert.equal(flow().pendingAction, null);
});

test('a settled account reports no attempt to adopt', async () => {
  for (const runtimeState of ['authenticated', 'not_logged_in', 'refresh_failed']) {
    const flow = await mountFlow(bridgeReporting(runtimeState));
    assert.equal(flow().hostAttemptPending, false, runtimeState);
    cleanupFakeDom();
  }
});

// An attempt this surface owns is already covered by the pending action, and
// must not be reported twice: the import gate would then read a grant the user
// can see running in front of them as someone else's.
test('an attempt this surface started is not reported as unowned', async () => {
  const flow = await mountFlow(bridgeReporting('authorizing'));
  await act(async () => {
    void flow().startLogin();
  });

  assert.equal(flow().pendingAction, 'login');
  assert.equal(flow().actionBusy, true);
  assert.equal(flow().hostAttemptPending, false);
});
