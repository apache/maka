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

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { desktopReleaseTargets } from './desktop-release-targets.mjs';

/**
 * Builds what the packaging runners would have uploaded, so a test can exercise
 * staging and publication without producing real installers. The descriptor
 * names every file, blockmaps included, so this stays in step with it. Both
 * channels stage the same shape, so both are built here; a formal release adds
 * checksum sidecars, which only its own caller knows the contract for.
 */
export async function writeDesktopReleaseInput(directory, version, { nightly = false } = {}) {
  await Promise.all(
    desktopReleaseTargets(version, { nightly }).map(async (target) => {
      const files = [];
      for (const artifact of target.payloads) {
        const bytes = Buffer.from(`${artifact} bytes`);
        await writeFile(join(directory, artifact), bytes);
        if (!target.advertised.includes(artifact)) continue;
        files.push({
          url: artifact,
          sha512: createHash('sha512').update(bytes).digest('base64'),
          size: bytes.byteLength,
        });
      }
      await writeFile(
        join(directory, target.feed),
        stringify({
          version,
          files,
          path: files[0].url,
          sha512: files[0].sha512,
          releaseDate: '2026-08-29T18:17:00.000Z',
        }),
      );
    }),
  );
}
