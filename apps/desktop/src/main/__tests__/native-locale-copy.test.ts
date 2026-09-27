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

import assert from 'node:assert/strict';
import test from 'node:test';
import { getNativeDiagnosticDialogCopy } from '../native-diagnostic-dialog-copy.js';
import { getPermissionOverlayCopy } from '../permission-overlay/permission-overlay-copy.js';
import { buildRuntimeHostActiveQuitDialog } from '../runtime-host-quit-copy.js';

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'function' ? item.toString() : item,
  );
}

test('native copy ships real Korean for every translated surface', () => {
  const surfaces: ReadonlyArray<{
    name: string;
    en: () => unknown;
    ko: () => unknown;
  }> = [
    {
      name: 'diagnostic dialog',
      en: () => getNativeDiagnosticDialogCopy('en'),
      ko: () => getNativeDiagnosticDialogCopy('ko'),
    },
    {
      name: 'permission overlay',
      en: () => getPermissionOverlayCopy('en', 'screen_recording'),
      ko: () => getPermissionOverlayCopy('ko', 'screen_recording'),
    },
    {
      name: 'runtime host quit dialog',
      en: () => buildRuntimeHostActiveQuitDialog('en'),
      ko: () => buildRuntimeHostActiveQuitDialog('ko'),
    },
  ];

  for (const surface of surfaces) {
    const en = stringify(surface.en());
    const ko = stringify(surface.ko());
    assert.match(
      ko,
      /[\uAC00-\uD7A3]/,
      `${surface.name}: ko copy must contain Hangul`,
    );
    assert.notEqual(
      ko,
      en,
      `${surface.name}: ko copy must differ from the en stub`,
    );
  }
});