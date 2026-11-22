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

import { signal } from 'nsh';

export type ThemeMode = 'dark' | 'light';

export interface Palette {
  bg: string;
  surface: string;
  surfaceRaised: string;
  glassBg: string;
  glassBorder: string;
  ink: string;
  ink2: string;
  ink3: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  userBubble: string;
  userBubbleText: string;
  line: string;
  ok: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerSoft: string;
  diffAddBg: string;
  diffAddInk: string;
  diffDelBg: string;
  diffDelInk: string;
}

const DARK: Palette = {
  bg: '#0B0B0E',
  surface: '#131419',
  surfaceRaised: '#1B1D24',
  glassBg: 'rgba(24, 26, 34, 0.88)',
  glassBorder: 'rgba(255, 255, 255, 0.09)',
  ink: '#ECEEF2',
  ink2: '#9A9FA8',
  ink3: '#636873',
  accent: '#5C8DFF',
  accentSoft: 'rgba(92, 141, 255, 0.16)',
  accentText: '#FFFFFF',
  userBubble: '#3466EB',
  userBubbleText: '#FFFFFF',
  line: 'rgba(255, 255, 255, 0.08)',
  ok: '#34C77B',
  warn: '#F0A83A',
  warnSoft: 'rgba(240, 168, 58, 0.14)',
  danger: '#F05A5A',
  dangerSoft: 'rgba(240, 90, 90, 0.14)',
  diffAddBg: 'rgba(52, 199, 123, 0.12)',
  diffAddInk: '#7AE8AD',
  diffDelBg: 'rgba(240, 90, 90, 0.12)',
  diffDelInk: '#F99B9B',
};

const LIGHT: Palette = {
  bg: '#F6F5F0',
  surface: '#FFFFFF',
  surfaceRaised: '#ECEAE2',
  glassBg: 'rgba(255, 255, 255, 0.88)',
  glassBorder: 'rgba(18, 22, 32, 0.09)',
  ink: '#16181D',
  ink2: '#5F6572',
  ink3: '#8C929E',
  accent: '#3466EB',
  accentSoft: 'rgba(52, 102, 235, 0.11)',
  accentText: '#FFFFFF',
  userBubble: '#3466EB',
  userBubbleText: '#FFFFFF',
  line: 'rgba(18, 22, 32, 0.08)',
  ok: '#1F9D5C',
  warn: '#C47D12',
  warnSoft: 'rgba(196, 125, 18, 0.11)',
  danger: '#D63B3B',
  dangerSoft: 'rgba(214, 59, 59, 0.10)',
  diffAddBg: 'rgba(31, 157, 92, 0.10)',
  diffAddInk: '#146B3E',
  diffDelBg: 'rgba(214, 59, 59, 0.09)',
  diffDelInk: '#9E2424',
};

export const themeMode = signal<ThemeMode>('dark');

export function palette(): Palette {
  return themeMode() === 'dark' ? DARK : LIGHT;
}

export function toggleThemeMode(): void {
  themeMode.set(themeMode() === 'dark' ? 'light' : 'dark');
}
