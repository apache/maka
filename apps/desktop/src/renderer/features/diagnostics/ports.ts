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

import type { ToastErrorAction } from '@maka/ui';

/** What an error toast hands to its report action. */
export type ToastDiagnosticReport = Parameters<ToastErrorAction['onClick']>[0];

/** The Desktop diagnostics capabilities the renderer root used to reach directly. */
export interface DiagnosticsServices {
  /** Copies a diagnostic report for an error toast the user chose to report. */
  copyToastReport(report: ToastDiagnosticReport): Promise<void>;
  /**
   * Reads whether the previous main process ended without finishing its
   * shutdown. Desktop reads it once per renderer; later calls return the same
   * answer.
   */
  takePreviousMainProcessInterruption(): Promise<boolean>;
  copyPreviousMainProcessInterruption(): Promise<void>;
}
