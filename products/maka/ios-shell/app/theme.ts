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

export function installTheme() {
  setTheme({
    cssVars: {
      light: {
        background: '#F7F7F9',
        secondary: '#F1F1F4',
        card: '#FFFFFF',
        muted: '#EBEBF0',
        hover: 'rgba(0, 0, 0, 0.045)',
        selected: 'rgba(0, 0, 0, 0.08)',
        separator: 'rgba(0, 0, 0, 0.14)',
        border: 'rgba(0, 0, 0, 0.08)',
        foreground: '#141416',
        'muted-foreground': '#68686E',
        subdued: '#9E9EA6',
        primary: '#141416',
        'primary-foreground': '#FFFFFF',
        accent: '#141416',
        'accent-soft': 'rgba(20, 20, 22, 0.07)',
        'accent-foreground': '#FFFFFF',
        success: '#248A3D',
        working: '#141416',
        warning: '#D97706',
        offline: '#9E9EA6',
        destructive: '#D70015',
        'destructive-soft': 'rgba(215, 0, 21, 0.10)',
        'user-bubble': '#141416',
        'user-bubble-foreground': '#FFFFFF',
        glass: 'rgba(255, 255, 255, 0.90)',
        'glass-border': 'rgba(0, 0, 0, 0.10)',
        'diff-add': 'rgba(36, 138, 61, 0.10)',
        'diff-add-foreground': '#1D7A34',
        'diff-delete': 'rgba(215, 0, 21, 0.09)',
        'diff-delete-foreground': '#C40014',
        scrim: 'rgba(0, 0, 0, 0.28)',
      },
      dark: {
        background: '#000000',
        secondary: '#08080A',
        card: '#151619',
        muted: '#202127',
        hover: 'rgba(255, 255, 255, 0.045)',
        selected: 'rgba(255, 255, 255, 0.085)',
        separator: 'rgba(255, 255, 255, 0.14)',
        border: 'rgba(255, 255, 255, 0.085)',
        foreground: '#F2F2F7',
        'muted-foreground': '#8E8E93',
        subdued: '#58585E',
        primary: '#F2F2F7',
        'primary-foreground': '#000000',
        accent: '#F2F2F7',
        'accent-soft': 'rgba(255, 255, 255, 0.09)',
        'accent-foreground': '#000000',
        success: '#30D158',
        working: '#FFFFFF',
        warning: '#FF9F0A',
        offline: '#58585E',
        destructive: '#FF453A',
        'destructive-soft': 'rgba(255, 69, 58, 0.14)',
        'user-bubble': '#1F2128',
        'user-bubble-foreground': '#F2F2F7',
        glass: 'rgba(34, 36, 44, 0.86)',
        'glass-border': 'rgba(255, 255, 255, 0.16)',
        'diff-add': 'rgba(48, 209, 88, 0.14)',
        'diff-add-foreground': '#30D158',
        'diff-delete': 'rgba(255, 69, 58, 0.14)',
        'diff-delete-foreground': '#FF453A',
        scrim: 'rgba(0, 0, 0, 0.56)',
      },
    },
  });
}

export const motion = { fast: 150, layout: 220 };
