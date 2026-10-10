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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { DiagnosticsServices } from '../../features/diagnostics/index.js';

export type DesktopDiagnosticsBridge = Pick<MakaBridge, 'diagnostics'>;

/** The only Desktop-to-Diagnostics adapter. */
export function createDesktopDiagnosticsServices(
  bridge: DesktopDiagnosticsBridge = window.maka,
): DiagnosticsServices {
  return {
    copyToastReport: (report) => bridge.diagnostics.copyReport({
      surface: 'toast',
      title: report.title,
      ...(report.description ? { description: report.description } : {}),
      ...(report.diagnosticDetails ? { details: report.diagnosticDetails } : {}),
      ...(report.diagnosticTarget ? { target: report.diagnosticTarget } : {}),
    }),
    copyManualReport: (target) => bridge.diagnostics.copyReport({
      surface: 'manual',
      ...(target ? { target } : {}),
    }),
    copyRendererCrashReport: (report) => bridge.diagnostics.copyReport({
      surface: 'renderer_crash',
      title: report.title,
      details: report.details,
    }),
    takePreviousMainProcessInterruption: () => bridge.diagnostics.takePreviousMainProcessInterruption(),
    copyPreviousMainProcessInterruption: () => bridge.diagnostics.copyPreviousMainProcessInterruption(),
  };
}
