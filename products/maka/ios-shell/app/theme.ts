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
  drawerBg: string;
  surface: string;
  surface2: string;
  rowHover: string;
  rowActive: string;
  guideLine: string;
  line: string;
  ink: string;
  ink2: string;
  ink3: string;
  primaryBg: string;
  primaryText: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  online: string;
  working: string;
  waiting: string;
  offline: string;
  danger: string;
  dangerSoft: string;
  userBubble: string;
  userBubbleText: string;
  glassBg: string;
  glassBorder: string;
  diffAddBg: string;
  diffAddInk: string;
  diffDelBg: string;
  diffDelInk: string;
  scrim: string;
}

/**
 * V8 Monochrome Apple Pro Liquid Glass palette (built on V6 spatial skeleton
 * with Apple HIG grouped cards for Permission, AskUserQuestion, and Settings).
 */
export const DARK_PALETTE: Palette = {
  bg: '#000000',
  drawerBg: '#08080A',
  surface: '#151619',
  surface2: '#202127',
  rowHover: 'rgba(255, 255, 255, 0.045)',
  rowActive: 'rgba(255, 255, 255, 0.085)',
  guideLine: 'rgba(255, 255, 255, 0.14)',
  line: 'rgba(255, 255, 255, 0.085)',
  ink: '#F2F2F7',
  ink2: '#8E8E93',
  ink3: '#58585E',
  primaryBg: '#F2F2F7',
  primaryText: '#000000',
  accent: '#F2F2F7',
  accentSoft: 'rgba(255, 255, 255, 0.09)',
  accentText: '#000000',
  online: '#30D158',
  working: '#FFFFFF',
  waiting: '#FF9F0A',
  offline: '#58585E',
  danger: '#FF453A',
  dangerSoft: 'rgba(255, 69, 58, 0.14)',
  userBubble: '#1F2128',
  userBubbleText: '#F2F2F7',
  glassBg: 'rgba(34, 36, 44, 0.86)',
  glassBorder: 'rgba(255, 255, 255, 0.16)',
  diffAddBg: 'rgba(48, 209, 88, 0.14)',
  diffAddInk: '#30D158',
  diffDelBg: 'rgba(255, 69, 58, 0.14)',
  diffDelInk: '#FF453A',
  scrim: 'rgba(0, 0, 0, 0.56)',
};

export const LIGHT_PALETTE: Palette = {
  bg: '#F7F7F9',
  drawerBg: '#F1F1F4',
  surface: '#FFFFFF',
  surface2: '#EBEBF0',
  rowHover: 'rgba(0, 0, 0, 0.045)',
  rowActive: 'rgba(0, 0, 0, 0.08)',
  guideLine: 'rgba(0, 0, 0, 0.14)',
  line: 'rgba(0, 0, 0, 0.08)',
  ink: '#141416',
  ink2: '#68686E',
  ink3: '#9E9EA6',
  primaryBg: '#141416',
  primaryText: '#FFFFFF',
  accent: '#141416',
  accentSoft: 'rgba(20, 20, 22, 0.07)',
  accentText: '#FFFFFF',
  online: '#248A3D',
  working: '#141416',
  waiting: '#D97706',
  offline: '#9E9EA6',
  danger: '#D70015',
  dangerSoft: 'rgba(215, 0, 21, 0.10)',
  userBubble: '#141416',
  userBubbleText: '#FFFFFF',
  glassBg: 'rgba(255, 255, 255, 0.90)',
  glassBorder: 'rgba(0, 0, 0, 0.10)',
  diffAddBg: 'rgba(36, 138, 61, 0.10)',
  diffAddInk: '#1D7A34',
  diffDelBg: 'rgba(215, 0, 21, 0.09)',
  diffDelInk: '#C40014',
  scrim: 'rgba(0, 0, 0, 0.28)',
};

export const themeMode = signal<ThemeMode>('dark');

export function palette(): Palette {
  return themeMode() === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
}

export function toggleThemeMode(): void {
  themeMode.set(themeMode() === 'dark' ? 'light' : 'dark');
}
