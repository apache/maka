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
import { ToastProvider, useUiLocale, type ToastErrorAction } from '@maka/ui';
import { getShellCopy } from '../../../locales/shell-copy.js';
import { useDiagnosticsServices } from '../services-context.js';

/**
 * The renderer's toast layer, with the Desktop diagnostic report offered on
 * error toasts.
 *
 * The action's words stay in the shared shell catalog beside the Error
 * Boundary and command palette copy that use the same ones. The report action
 * is rebuilt only when the locale changes; the injected services are created
 * once at composition, so toast consumers do not see a new action on
 * unrelated renders.
 */
export function DiagnosticReportToastProvider(props: { readonly children?: ReactNode }) {
  const services = useDiagnosticsServices();
  const copy = getShellCopy(useUiLocale());
  const label = copy.errorBoundary.copyReport;
  const failureTitle = copy.commandActions.copyFailedTitle;
  const failureDescription = copy.commandActions.clipboardDenied;
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
