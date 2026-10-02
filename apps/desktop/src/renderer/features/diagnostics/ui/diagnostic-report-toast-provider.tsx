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

import { useMemo, type ReactNode } from 'react';
import { ToastProvider, type ToastErrorAction } from '@maka/ui';
import { useDiagnosticsServices } from '../services-context.js';

/** The report action's copy. AppShell supplies it from the shared shell catalog. */
interface DiagnosticReportToastLabels {
  readonly label: string;
  readonly failureTitle: string;
  readonly failureDescription: string;
}

/**
 * The renderer's toast layer, with the Desktop diagnostic report offered on
 * error toasts.
 *
 * The report action is rebuilt only when a label changes; the injected
 * services are created once at composition, so toast consumers do not see a
 * new action on unrelated renders.
 */
export function DiagnosticReportToastProvider(props: {
  readonly labels: DiagnosticReportToastLabels;
  readonly children?: ReactNode;
}) {
  const services = useDiagnosticsServices();
  const { label, failureTitle, failureDescription } = props.labels;
  const errorAction = useMemo<ToastErrorAction>(
    () => ({
      label,
      failureTitle,
      failureDescription,
      onClick: (report) => services.copyToastReport(report),
    }),
    [services, label, failureTitle, failureDescription],
  );
  return <ToastProvider errorAction={errorAction}>{props.children}</ToastProvider>;
}
