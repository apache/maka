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

import { formatWithOptions } from 'node:util';
import type { DiagnosticLogBuffer } from './diagnostic-log.js';

const MAX_LOG_ENTRY_CODE_POINTS = 8 * 1024;

export function installConsoleDiagnosticLogCapture(buffer: DiagnosticLogBuffer): void {
  for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        buffer.append(
          level,
          formatWithOptions(
            {
              breakLength: 160,
              colors: false,
              compact: 3,
              depth: 4,
              maxArrayLength: 50,
              maxStringLength: MAX_LOG_ENTRY_CODE_POINTS,
            },
            ...args,
          ),
        );
      } catch {
        // Diagnostic capture must not change console behavior.
      }
      original(...args);
    };
  }
}
