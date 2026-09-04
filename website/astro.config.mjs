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

import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { defineConfig } from 'astro/config';

const require = createRequire(import.meta.url);

// The Geist faces are under the SIL Open Font License, which must travel with
// the font files, so the build ships each package's LICENSE next to them.
const fontLicenses = {
  name: 'font-licenses',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      for (const pkg of ['geist', 'geist-mono']) {
        const target = new URL(`licenses/${pkg}/`, dir);
        await mkdir(target, { recursive: true });
        await copyFile(
          require.resolve(`@fontsource-variable/${pkg}/LICENSE`),
          new URL('LICENSE', target),
        );
      }
    },
  },
};

export default defineConfig({
  site: 'https://maka.apache.org',
  trailingSlash: 'always',
  integrations: [fontLicenses],
  // Both languages live under their own prefix; src/pages/index.astro sends
  // the root to /en/ itself.
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh-CN'],
    routing: {
      prefixDefaultLocale: true,
      redirectToDefaultLocale: false,
    },
  },
});
