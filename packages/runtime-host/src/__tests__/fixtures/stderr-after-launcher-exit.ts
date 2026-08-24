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

import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { installRuntimeHostLogCapture } from '../../process-diagnostics.js';

const markerPath = process.env.MAKA_TEST_STDERR_AFTER_PARENT_EXIT_MARKER;
if (!markerPath) throw new Error('stderr survival marker path is required');

installRuntimeHostLogCapture();
setTimeout(() => {
  console.error('[runtime-host] stderr after launcher exit');
  const temporaryMarkerPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  void writeFile(temporaryMarkerPath, 'alive')
    .then(() => rename(temporaryMarkerPath, markerPath))
    .catch(() => {
      process.exitCode = 1;
    });
}, 500);
setInterval(() => undefined, 1_000);
