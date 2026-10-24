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

/** The task or Host profile a manual report is about, when the user is looking at one. */
export type ManualDiagnosticTarget =
  | { readonly sessionId: string; readonly profileId?: never }
  | { readonly profileId: string; readonly sessionId?: never };

/** What the Error Boundary hands to the report of a renderer crash. */
export interface RendererCrashDiagnosticReport {
  readonly title: string;
  /** The error and its stacks, already redacted. */
  readonly details: string;
}

/** The Desktop diagnostics capabilities the renderer used to reach directly. */
export interface DiagnosticsServices {
  /** Copies a diagnostic report for an error toast the user chose to report. */
  copyToastReport(report: ToastDiagnosticReport): Promise<void>;
  /** Copies the report the user asked for from About or the command palette. */
  copyManualReport(target?: ManualDiagnosticTarget): Promise<void>;
  /** Copies the report for a renderer crash the Error Boundary caught. */
  copyRendererCrashReport(report: RendererCrashDiagnosticReport): Promise<void>;
  /**
   * Reads whether the previous main process ended without finishing its
   * shutdown. Desktop reads it once per renderer; later calls return the same
   * answer.
   */
  takePreviousMainProcessInterruption(): Promise<boolean>;
  copyPreviousMainProcessInterruption(): Promise<void>;
}
