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

import { StrictMode, useEffect } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { makaTheme } from './astryx-theme/maka';
import { AppShell } from './app-shell';
import { useAstryxThemeMode } from './astryx-theme-mode';
import type { OnboardingSnapshot } from '../preload/bridge-contract.js';

export function App({
  initialOnboardingSnapshot = null,
}: {
  /** Pre-mount snapshot prefetched by main.tsx — see prefetchOnboardingSnapshot. */
  initialOnboardingSnapshot?: OnboardingSnapshot | null;
}) {
  // PR-SHOW-AFTER-FIRST-COMMIT: the BrowserWindow is created hidden
  // (main-window.ts show: false) so the OS never flashes the index.html
  // `.maka-preload` skeleton before React paints. A layout effect is too early
  // for this signal: it runs after the DOM commit but before Chromium paints,
  // so the main process can show the BrowserWindow while its last composited
  // frame is still the preload skeleton. Two animation frames put the signal
  // after at least one paint of the committed AppShell. This remains
  // unconditional: even when the onboarding snapshot is null and AppShell
  // mounts its fail-soft loading state, the window should still appear. The
  // main-process fallback handles a renderer that never reaches either frame.
  // `window.maka` is undefined outside Electron (storybook), so guard it.
  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        void window.maka?.appWindow?.notifyRendererReady?.();
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, []);
  // Astryx owns the component/design system (issue #1565). It sits inside
  // StrictMode and follows our already-resolved color mode; see
  // astryx-theme-mode.ts for why we don't hand it `mode="system"`.
  const astryxMode = useAstryxThemeMode();
  return (
    <StrictMode>
      <Theme theme={makaTheme} mode={astryxMode}>
        <AppShell initialOnboardingSnapshot={initialOnboardingSnapshot} />
      </Theme>
    </StrictMode>
  );
}
