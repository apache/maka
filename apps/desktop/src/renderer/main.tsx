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

import { createRoot } from 'react-dom/client';
import { syncUiLocaleDocument } from '@maka/ui';
import { App } from './app';
import { applyCachedThemeBeforeMount } from './cached-theme-bootstrap';
import './styles.css';
import { readSystemUiLocale } from './use-system-ui-locale';
import { isWebMode } from './platform/web/web-project.js';
import {
  createDesktopFeatureServices,
  DesktopFeatureServicesProvider,
} from './composition/desktop-feature-services';

const ONBOARDING_SNAPSHOT_RETRY_DELAY_MS = 150;
const ONBOARDING_SNAPSHOT_TIMEOUT_MS = 2_500;

syncUiLocaleDocument(readSystemUiLocale());
applyCachedThemeBeforeMount();

// Plain browser (Chrome/Brave via `maka-web`): no preload bridge, so the
// desktop service factories below would throw on `window.maka` and leave the
// index.html skeleton on screen.
//
// Two browser tiers:
// - Full client: same-origin `/bridge` after passphrase+TOTP (session cookie).
//   Opened by `npm run maka-web` while the GUI runs. The disk token never
//   appears in the URL.
// - Picker: full client unavailable (GUI/bridge down). Self-contained
//   directory validator with handoff instructions; never touches the bridge.
if (isWebMode()) {
  void import('./platform/web/web-boot.js').then(({ bootWebBridge, webBridgeParams }) => {
    const params = webBridgeParams();
    if (!params) {
      bootWebPicker();
      return;
    }
    bootWebBridge(params).then(
      () => bootDesktop(),
      (error) => bootWebPicker(error),
    );
  });
} else {
  bootDesktop();
}

function bootWebPicker(error?: unknown) {
  if (error) console.error('[web] full client unavailable, falling back to picker:', error);
  void import('./platform/web/web-app.js').then(({ WebApp }) => {
    createRoot(document.getElementById('root')!).render(<WebApp />);
  });
}

function bootDesktop() {
  const desktopFeatureServices = createDesktopFeatureServices();

/**
 * Prefetch the onboarding snapshot BEFORE mounting React. The preload
 * skeleton (index.html) stays on screen while this resolves, so the first
 * React commit already has sessions + connections and paints the real
 * chat surface directly — no intermediate loading card, no layout jump
 * (the "配置页闪了一下" startup flash).
 *
 * Fail-open: one quick retry (the IPC handler may not be registered in
 * the first milliseconds), then a hard timeout so a wedged main process
 * can never block the renderer from mounting. On timeout/failure React
 * mounts with `null` and the classic in-app loading path takes over.
 */
async function prefetchOnboardingSnapshot(
  desktopFeatureServices: ReturnType<typeof createDesktopFeatureServices>,
) {
  // WorkHub owns its session readiness and never consumes Desktop onboarding.
  if (desktopFeatureServices.workHub.surface === 'workhub') return null;
  const attempt = async () => {
    try {
      return await window.maka.onboarding.getSnapshot();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, ONBOARDING_SNAPSHOT_RETRY_DELAY_MS));
      try {
        return await window.maka.onboarding.getSnapshot();
      } catch {
        return null;
      }
    }
  };
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ONBOARDING_SNAPSHOT_TIMEOUT_MS));
  return Promise.race([attempt(), timeout]);
}

void prefetchOnboardingSnapshot(desktopFeatureServices).then((initialOnboardingSnapshot) => {
  createRoot(document.getElementById('root')!).render(
    <DesktopFeatureServicesProvider services={desktopFeatureServices}>
      <App initialOnboardingSnapshot={initialOnboardingSnapshot} />
    </DesktopFeatureServicesProvider>,
  );
});
}
