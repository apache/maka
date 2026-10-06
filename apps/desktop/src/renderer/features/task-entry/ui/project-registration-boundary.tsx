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

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useToast, useUiLocale } from '@maka/ui';
import { getShellCopy } from '../../../locales/shell-copy.js';
import type { TaskEntryHostRef, TaskEntryProjectMutationResult } from '../ports.js';
import { useTaskEntryServices } from '../services-context.js';
import { resolveProjectRegistration } from '../controller/resolve-project-registration.js';

export interface ProjectRegistration {
  readonly pending: boolean;
  register(
    operation: () => Promise<TaskEntryProjectMutationResult>,
    isCurrent?: () => boolean,
  ): Promise<TaskEntryProjectMutationResult | undefined>;
}

/** Owns only the single-flight registration/archived-project recovery transaction. */
export function ProjectRegistrationBoundary(props: {
  host?: TaskEntryHostRef;
  children(registration: ProjectRegistration): ReactNode;
}) {
  const { catalog } = useTaskEntryServices();
  const toast = useToast();
  const locale = useUiLocale();
  const copy = getShellCopy(locale).projectActions;
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    generation.current += 1;
    inFlight.current = false;
    setPending(false);
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [props.host?.profileId, props.host?.hostId, catalog, locale]);

  async function register(
    operation: () => Promise<TaskEntryProjectMutationResult>,
    isCurrent: () => boolean = () => true,
  ): Promise<TaskEntryProjectMutationResult | undefined> {
    const host = props.host;
    if (!host || !mounted.current || inFlight.current || !isCurrent()) return;
    const sequence = generation.current;
    const current = () => mounted.current && generation.current === sequence && isCurrent();
    inFlight.current = true;
    setPending(true);
    try {
      return await resolveProjectRegistration({
        register: operation,
        confirm: (onConfirm) => toast.confirm({
          onConfirm,
          title: copy.archivedProjectTitle,
          description: copy.archivedProjectDescription,
          confirmLabel: copy.archivedProjectRestore,
          cancelLabel: copy.archivedProjectCancel,
        }),
        restore: (projectId) => catalog.restoreProject(host, projectId),
        isCurrent: current,
      });
    } catch (cause) {
      if (current()) throw cause;
    } finally {
      if (mounted.current && generation.current === sequence) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }

  return props.children({ pending, register });
}
