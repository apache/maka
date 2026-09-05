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

import { useEffect, useState } from 'react';
import type { ThemeMode } from '@astryxdesign/core/theme';

const DARK_CLASS = 'dark';

function readMode(): ThemeMode {
  return document.documentElement.classList.contains(DARK_CLASS) ? 'dark' : 'light';
}

/**
 * Astryx follows OUR resolved color mode instead of running its own
 * `mode="system"` resolution.
 *
 * `<html class="dark">` is already the single source of truth for the resolved
 * mode: `applyCachedThemeBeforeMount` sets it before React mounts (FOUC
 * prevention) and `applyTheme` maintains it afterwards, including the `auto`
 * preference's matchMedia subscription, the palette attribute and the Electron
 * titlebar-overlay sync. Letting Astryx resolve `system` independently would
 * create a second source of truth that can disagree with ours for a frame — so
 * we observe the class and hand Astryx an already-resolved `light`/`dark`.
 */
export function useAstryxThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>(readMode);

  useEffect(() => {
    const sync = () => {
      setMode((current) => {
        const next = readMode();
        return current === next ? current : next;
      });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return mode;
}
