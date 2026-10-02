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

import { useEffect, useRef } from 'react';
import { useToast, useUiLocale } from '@maka/ui';
import { getDiagnosticsCopy } from '../locales/diagnostics-copy.js';
import { useDiagnosticsServices } from '../services-context.js';

/**
 * Tells the user, once per renderer, that the previous main process did not
 * finish shutting down, and offers the report for that run.
 *
 * `ready` holds the read until the shell's appearance settings have hydrated.
 * The notice renders nothing; it only owns the read and the toast.
 */
export function PreviousMainProcessInterruptionNotice(props: { readonly ready: boolean }) {
  const { ready } = props;
  const services = useDiagnosticsServices();
  const toastApi = useToast();
  const locale = useUiLocale();
  const copy = getDiagnosticsCopy(locale).previousMainProcessInterruption;
  const shownRef = useRef(false);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void services
      .takePreviousMainProcessInterruption()
      .then((interrupted) => {
        if (cancelled || !interrupted || shownRef.current) return;
        shownRef.current = true;
        toastApi.toast({
          variant: 'warning',
          title: copy.title,
          description: copy.description,
          duration: 10_000,
          action: {
            label: copy.copyDiagnostics,
            onClick: () => services.copyPreviousMainProcessInterruption(),
          },
        });
      })
      .catch((error) =>
        console.error('[diagnostics] previous-session notice failed:', error),
      );
    return () => {
      cancelled = true;
    };
  }, [ready, copy, services, toastApi]);
  return null;
}
