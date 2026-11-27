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

import { setTheme } from 'nsh';

const light = {
  background: '#F2F2F7',
  'grouped-bg': '#F2F2F7',
  canvas: '#FFFFFF',
  'inline-card': '#F2F2F7',
  'inline-command': '#FFFFFF',
  surface: '#FFFFFF',
  card: '#FFFFFF',
  'surface-elevated': '#FFFFFF',
  'glass-bg': 'rgba(255, 255, 255, 0.68)',
  'glass-pressed-bg': 'rgba(221, 221, 229, 0.82)',
  'glass-border': 'rgba(0, 0, 0, 0.08)',
  'glass-shadow': 'rgba(0, 0, 0, 0.09)',
  'surface-muted': '#E5E5EA',
  muted: '#E5E5EA',
  'row-pressed': 'rgba(60, 60, 67, 0.08)',
  separator: 'rgba(60, 60, 67, 0.22)',
  border: 'rgba(60, 60, 67, 0.14)',
  foreground: '#000000',
  'muted-foreground': 'rgba(60, 60, 67, 0.68)',
  'tertiary-foreground': 'rgba(60, 60, 67, 0.36)',
  'glass-foreground': '#171719',
  'glass-muted': '#4F4F57',
  'glass-accent': '#0059B8',
  'glass-primary-pressed-bg': '#004B9C',
  'glass-destructive': '#9C3040',
  'glass-action-bg': '#E0ECFA',
  'glass-action-pressed-bg': '#C9DCF3',
  primary: '#007AFF',
  'primary-foreground': '#FFFFFF',
  'primary-tint': 'rgba(0, 122, 255, 0.12)',
  'user-bubble-tint': '#EBF3FF',
  success: '#34C759',
  'success-tint': 'rgba(52, 199, 89, 0.13)',
  warning: '#FF9500',
  'warning-tint': 'rgba(255, 149, 0, 0.13)',
  destructive: '#FF3B30',
  'destructive-tint': 'rgba(255, 59, 48, 0.12)',
  'approval-session-bg': 'rgba(0, 90, 180, 0.07)',
  'approval-reject': '#9C3040',
  'approval-accepted': '#1F8B3C',
  'approval-accepted-bg': 'rgba(52, 199, 89, 0.12)',
  offline: '#8E8E93',
  indigo: '#5856D6',
  teal: '#30B0C7',
  purple: '#AF52DE',
  'diff-add-bg': 'rgba(52, 199, 89, 0.14)',
  'diff-add-fg': '#1B7A34',
  'diff-del-bg': 'rgba(255, 59, 48, 0.12)',
  'diff-del-fg': '#C9251D',
  scrim: 'rgba(0, 0, 0, 0.28)',
  'scanner-bg': '#000000',
  'scanner-scrim': 'rgba(0, 0, 0, 0.56)',
  'scanner-fg': '#FFFFFF',
  'scanner-pill': 'rgba(28, 28, 30, 0.78)',
};

type IosColors = { [K in keyof typeof light]: string };
declare module 'nsh' {
  interface Tokens extends IosColors {}
}

export function installTheme() {
  setTheme({
    cssVars: {
      light,
      dark: {
        background: '#000000',
        'grouped-bg': '#000000',
        canvas: '#000000',
        'inline-card': '#1C1C1E',
        'inline-command': '#2C2C2E',
        surface: '#1C1C1E',
        card: '#1C1C1E',
        'surface-elevated': '#2C2C2E',
        'glass-bg': 'rgba(36, 36, 38, 0.66)',
        'glass-pressed-bg': 'rgba(54, 54, 59, 0.86)',
        'glass-border': 'rgba(255, 255, 255, 0.12)',
        'glass-shadow': 'rgba(0, 0, 0, 0.42)',
        'surface-muted': '#2C2C2E',
        muted: '#2C2C2E',
        'row-pressed': 'rgba(255, 255, 255, 0.09)',
        separator: 'rgba(84, 84, 88, 0.55)',
        border: 'rgba(84, 84, 88, 0.45)',
        foreground: '#FFFFFF',
        'muted-foreground': 'rgba(235, 235, 245, 0.65)',
        'tertiary-foreground': 'rgba(235, 235, 245, 0.36)',
        'glass-foreground': '#FAFAFC',
        'glass-muted': '#C8C8D0',
        'glass-accent': '#8DC8FF',
        'glass-primary-pressed-bg': '#70B3F4',
        'glass-destructive': '#E99A9B',
        'glass-action-bg': '#273B51',
        'glass-action-pressed-bg': '#354C65',
        primary: '#0A84FF',
        'primary-foreground': '#FFFFFF',
        'primary-tint': 'rgba(10, 132, 255, 0.18)',
        'user-bubble-tint': '#1B2D45',
        success: '#30D158',
        'success-tint': 'rgba(48, 209, 88, 0.18)',
        warning: '#FF9F0A',
        'warning-tint': 'rgba(255, 159, 10, 0.18)',
        destructive: '#FF453A',
        'destructive-tint': 'rgba(255, 69, 58, 0.16)',
        'approval-session-bg': '#202b36',
        'approval-reject': '#E99A9B',
        'approval-accepted': '#30D158',
        'approval-accepted-bg': 'rgba(48, 209, 88, 0.16)',
        offline: '#636366',
        indigo: '#5E5CE6',
        teal: '#40C8E0',
        purple: '#BF5AF2',
        'diff-add-bg': 'rgba(48, 209, 88, 0.18)',
        'diff-add-fg': '#68E089',
        'diff-del-bg': 'rgba(255, 69, 58, 0.18)',
        'diff-del-fg': '#FF7A73',
        scrim: 'rgba(0, 0, 0, 0.56)',
        'scanner-bg': '#000000',
        'scanner-scrim': 'rgba(0, 0, 0, 0.64)',
        'scanner-fg': '#FFFFFF',
        'scanner-pill': 'rgba(44, 44, 46, 0.82)',
      },
    },
  });
}

export const spacing = {
  pageX: 16,
  sectionGap: 24,
  groupRadius: 12,
  controlRadius: 12,
  pillRadius: 999,
  rowMinHeight: 44,
  buttonMinHeight: 50,
  hairline: 0.5,
  tabBarClearance: 128,
} as const;

export const type = {
  title2: { fontSize: 22, fontWeight: '700' as const, lineHeight: 28, letterSpacing: -0.3 },
  headline: { fontSize: 17, fontWeight: '600' as const, lineHeight: 22, letterSpacing: -0.2 },
  body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 22 },
  bodyMedium: { fontSize: 16, fontWeight: '500' as const, lineHeight: 22 },
  subheadline: { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
  subheadlineMedium: { fontSize: 14, fontWeight: '500' as const, lineHeight: 20 },
  footnote: { fontSize: 13, fontWeight: '400' as const, lineHeight: 18 },
  footnoteUpper: {
    fontSize: 13,
    fontWeight: '400' as const,
    lineHeight: 18,
    letterSpacing: 0.2,
  },
  caption: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16 },
  mono: { fontFamily: 'monospace', fontSize: 13, lineHeight: 18 },
  sasCode: {
    fontFamily: 'monospace',
    fontSize: 30,
    fontWeight: '700' as const,
    lineHeight: 38,
    letterSpacing: 4,
    fontVariant: ['tabular-nums' as const],
  },
} as const;

export const motion = {
  fast: 150,
  normal: 220,
  skeletonPulse: 2200,
  spring: { stiffness: 380, damping: 32 },
} as const;
