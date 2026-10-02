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

import { useLayoutEffect, type ReactNode } from 'react';
import { useToast } from '@maka/ui';
import { useComposerAttachments } from '../controller/use-composer-attachments.js';
import { stagingBindings } from '../model/composer-staging-binding.js';
import type { ComposerStagingCommands } from '../model/composer-staging-contract.js';
import { useComposerStagingServices } from '../staging-services.js';
import { captureComposerStaging } from '../controller/capture-composer-staging.js';
import { ComposerStagingContext } from './composer-staging-context.js';

/** Persistent draft owner. Its children are composed by the shell, never keyed
 * by Session, so staging updates only reach the regional context readers. */
export function ComposerStagingProvider(props: {
  readonly commands: ComposerStagingCommands;
  readonly draftKey: string;
  readonly directoryHostId?: string;
  readonly supportsVision?: boolean;
  readonly children?: ReactNode;
}) {
  const toastApi = useToast();
  const staging = useComposerAttachments({
    draftKey: props.draftKey,
    directoryHostId: props.directoryHostId,
    toastApi,
    service: useComposerStagingServices(),
    imageNotice: { supportsVision: () => props.supportsVision, notify: toastApi.info },
  });
  useLayoutEffect(() => {
    const binding = stagingBindings.get(props.commands);
    if (!binding) throw new Error('Unknown Composer staging commands');
    const commands: ComposerStagingCommands = {
      captureSubmission: () => captureComposerStaging(staging, props.draftKey),
      addQuote: staging.addQuote,
      resetImageNotice: (key) => staging.imageNoticeLifecycle.reset(key),
      transferImageNotice: (from, to) => staging.imageNoticeLifecycle.transfer(from, to),
    };
    binding.current = commands;
    return () => { if (binding.current === commands) binding.current = undefined; };
  }, [props.commands, props.draftKey, staging]);
  return <ComposerStagingContext.Provider value={{ ...staging, draftKey: props.draftKey }}>{props.children}</ComposerStagingContext.Provider>;
}
