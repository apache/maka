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

import type { ComponentProps } from 'react';
import { Composer } from '@maka/ui';
import { useComposerStaging } from './composer-staging-context.js';

export type ComposerStagingProp =
  | 'pendingAttachments' | 'onRemoveAttachment' | 'onPickAttachments' | 'onAttachFilePaths'
  | 'pendingDirectories' | 'onRemoveDirectory' | 'onPickDirectory'
  | 'pendingQuotes' | 'onRemoveQuote' | 'onEditQuoteComment' | 'onAnnotateQuote';

/** Actual Composer reader; no staging projection travels through AppShell. */
export function StagedComposer({
  stagingEnabled, canStageContext, contextPickEnabled, directoryPickerEnabled, ...props
}: Omit<ComponentProps<typeof Composer>, ComposerStagingProp> & {
  readonly stagingEnabled: boolean;
  readonly canStageContext: boolean;
  readonly contextPickEnabled: boolean;
  readonly directoryPickerEnabled: boolean;
}) {
  const staging = useComposerStaging();
  return <Composer {...props} {...(stagingEnabled ? {
    pendingAttachments: staging.pendingAttachments,
    onRemoveAttachment: staging.removeAttachment,
    onPickAttachments: contextPickEnabled ? staging.pickAttachments : undefined,
    onAttachFilePaths: contextPickEnabled ? staging.attachFilePaths : undefined,
    ...staging.composerQuoteProps(canStageContext),
    ...staging.directoryComposerProps,
    onPickDirectory: directoryPickerEnabled ? staging.directoryComposerProps.onPickDirectory : undefined,
  } : {})} />;
}
