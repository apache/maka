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

export interface DesktopExecutionDiagnosticTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
  readonly profileId?: never;
}

interface DesktopDiagnosticRendererContext {
  readonly rendererUserAgent?: string;
  readonly rendererLocale?: string;
}

export type DesktopManualDiagnosticTarget =
  | {
      readonly sessionId: string;
      readonly profileId?: never;
      readonly turnId?: never;
      readonly eventId?: never;
    }
  | {
      readonly profileId: string;
      readonly sessionId?: never;
      readonly turnId?: never;
      readonly eventId?: never;
    };

export type DesktopDiagnosticTarget =
  | DesktopManualDiagnosticTarget
  | DesktopExecutionDiagnosticTarget;

export interface DesktopManualDiagnosticInput {
  readonly surface: 'manual';
  readonly target?: DesktopManualDiagnosticTarget;
}

interface DesktopErrorDiagnosticDetails {
  readonly title: string;
  readonly description?: string;
  readonly details?: string;
}

export type DesktopErrorDiagnosticInput = DesktopErrorDiagnosticDetails &
  (
    | {
        readonly surface: 'toast';
        readonly target?: DesktopDiagnosticTarget;
      }
    | {
        readonly surface: 'renderer_crash';
        readonly target?: never;
      }
  );

export type DesktopDiagnosticInput = DesktopManualDiagnosticInput | DesktopErrorDiagnosticInput;

export type DesktopManualDiagnosticWireInput = Omit<DesktopManualDiagnosticInput, 'target'> &
  DesktopDiagnosticRendererContext & {
    readonly hostTarget: 'default' | 'task';
  };

export type DesktopErrorDiagnosticWireInput = DesktopErrorDiagnosticDetails &
  DesktopDiagnosticRendererContext &
  (
    | {
        readonly surface: 'toast';
        readonly hostTarget: 'none';
        readonly execution?: never;
      }
    | {
        readonly surface: 'toast';
        readonly hostTarget: 'task';
        readonly execution?: DesktopExecutionDiagnosticTarget;
      }
    | {
        readonly surface: 'renderer_crash';
        readonly hostTarget: 'none';
        readonly execution?: never;
      }
  );

export type DesktopDiagnosticWireInput =
  | DesktopManualDiagnosticWireInput
  | DesktopErrorDiagnosticWireInput;
