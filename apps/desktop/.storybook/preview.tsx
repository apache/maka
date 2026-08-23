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

import type { Decorator, Preview } from '@storybook/react-vite';
import '../src/renderer/styles.css';
import { Theme } from '@astryxdesign/core/theme';
import { THEME_PALETTES } from '../../../packages/core/src/settings.js';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import { makaTheme } from '../src/renderer/astryx-theme/maka';

const PALETTE_LABELS: Record<string, string> = {
  default: 'Default',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'tokyo-night': 'Tokyo Night',
};

const withMakaRoot: Decorator = (Story, context) => {
  const root = document.documentElement;
  const colorScheme = context.globals.colorScheme === 'dark' ? 'dark' : 'light';
  const palette = typeof context.globals.palette === 'string' ? context.globals.palette : 'default';
  // English is where settings layouts break first — its labels and helper
  // lines are ~1.8× the width of the Chinese copy, so a row that fits in zh
  // overflows, truncates, or clips in en. Stories were locked to `zh`, which
  // is exactly why those breakages only ever showed up in the shipped app.
  const locale = context.globals.locale === 'en' ? 'en' : 'zh';

  root.classList.toggle('dark', colorScheme === 'dark');
  root.style.colorScheme = colorScheme;

  if (palette === 'default') {
    root.removeAttribute('data-maka-theme');
  } else {
    root.setAttribute('data-maka-theme', palette);
  }

  // Mirror app.tsx / app-shell.tsx: <Theme> owns the Astryx context at the
  // root (mode follows the same resolved colorScheme as `.dark`), and
  // AstryxLocaleProvider sits INSIDE LocaleProvider because its message
  // catalog reads our locale context.
  if (context.title.startsWith('Product/')) {
    return (
      <Theme theme={makaTheme} mode={colorScheme}>
        <LocaleProvider locale={locale}>
          <AstryxLocaleProvider>
            <Story />
          </AstryxLocaleProvider>
        </LocaleProvider>
      </Theme>
    );
  }

  return (
    <Theme theme={makaTheme} mode={colorScheme}>
      <LocaleProvider locale={locale}>
        <AstryxLocaleProvider>
          <div className="h-screen w-screen overflow-y-auto bg-background p-6 text-foreground antialiased">
            <Story />
          </div>
        </AstryxLocaleProvider>
      </LocaleProvider>
    </Theme>
  );
};

const preview: Preview = {
  decorators: [withMakaRoot],
  globalTypes: {
    colorScheme: {
      description: 'Renderer color scheme',
      toolbar: {
        icon: 'mirror',
        items: [
          { title: 'Light', value: 'light' },
          { title: 'Dark', value: 'dark' },
        ],
      },
    },
    locale: {
      description: 'Renderer UI locale',
      toolbar: {
        icon: 'globe',
        items: [
          { title: '中文', value: 'zh' },
          { title: 'English', value: 'en' },
        ],
      },
    },
    palette: {
      description: 'Maka palette token set',
      toolbar: {
        icon: 'paintbrush',
        items: THEME_PALETTES.map((palette) => ({
          title: PALETTE_LABELS[palette] ?? palette.replace(/(^|-)(\w)/g, (_, p1, p2) => (p1 ? p2.toUpperCase() : p2)),
          value: palette,
        })),
      },
    },
  },
  initialGlobals: {
    colorScheme: 'light',
    locale: 'zh',
    palette: 'default',
  },
  parameters: {
    backgrounds: {
      disable: true,
    },
    controls: {
      expanded: true,
    },
  },
};

export default preview;
