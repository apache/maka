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

import { createElement, useMemo, type ReactNode } from 'react';
import { AstryxLocaleProvider, ToastProvider } from '@maka/ui';
import {
  ComposerStagingProvider, ComposerStagingServicesProvider, createComposerStagingCommands,
  type ComposerStagingCommands, type ComposerStagingServices,
} from '../../renderer/features/conversation/index.js';

const emptyServices: ComposerStagingServices = {
  pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
  previewApproval: async () => ({ ok: false, reason: 'unavailable' }),
};

/** Real owner with inert I/O, shared by renderer integration tests. */
export function ComposerStagingFixture(props: {
  readonly draftKey: string;
  readonly directoryHostId?: string;
  readonly commands?: ComposerStagingCommands;
  readonly services?: ComposerStagingServices;
  readonly children?: ReactNode;
}) {
  const fallbackCommands = useMemo(createComposerStagingCommands, []);
  return createElement(AstryxLocaleProvider, {
    children: createElement(ToastProvider, {
      children: createElement(ComposerStagingServicesProvider, {
        services: props.services ?? emptyServices,
        children: createElement(ComposerStagingProvider, {
          commands: props.commands ?? fallbackCommands,
          draftKey: props.draftKey,
          directoryHostId: props.directoryHostId,
          children: props.children,
        }),
      }),
    }),
  });
}
