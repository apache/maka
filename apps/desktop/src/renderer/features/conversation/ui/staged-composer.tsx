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

import { useRef, type ComponentProps } from 'react';
import { Composer, type ComposerSendMetadata } from '@maka/ui';
import {
  useSessionSettingsSettlement,
  type SessionSendSettlement,
} from '../../../application/contracts/session-settings-settlement.js';
import type { ComposerStagingSubmission } from '../model/composer-staging-contract.js';
import { captureComposerStaging } from '../controller/capture-composer-staging.js';
import { useComposerStaging } from './composer-staging-context.js';

export type ComposerStagingProp =
  | 'pendingAttachments' | 'onRemoveAttachment' | 'onPickAttachments' | 'onAttachFilePaths'
  | 'pendingDirectories' | 'onRemoveDirectory' | 'onPickDirectory'
  | 'pendingQuotes' | 'onRemoveQuote' | 'onEditQuoteComment' | 'onAnnotateQuote';

/** Actual Composer reader; no staging projection travels through AppShell. */
export function StagedComposer({
  stagingEnabled, canStageContext, contextPickEnabled, directoryPickerEnabled, ...props
}: Omit<ComponentProps<typeof Composer>, ComposerStagingProp | 'onSend'> & {
  readonly onSend: (
    text: string,
    metadata?: ComposerSendMetadata,
    staging?: ComposerStagingSubmission,
    settlement?: SessionSendSettlement,
  ) => boolean | void | Promise<boolean | void>;
  readonly stagingEnabled: boolean;
  readonly canStageContext: boolean;
  readonly contextPickEnabled: boolean;
  readonly directoryPickerEnabled: boolean;
}) {
  const staging = useComposerStaging();
  const sessionSettings = useSessionSettingsSettlement();
  // #4695: the attempt starts at the user's submit, before the Composer waits
  // on Session references or the send prepares a revision, so a setting write
  // that fails in between still stops this send.
  const settlementRef = useRef<SessionSendSettlement | undefined>(undefined);
  return <Composer {...props} onSend={(text, metadata) =>
    props.onSend(text, metadata, captureComposerStaging(staging, staging.draftKey), settlementRef.current)} {...(stagingEnabled ? {
    retainSendContext: () => {
      const releaseAttachments = staging.retainAttachments(staging.submittableAttachments);
      const settlement = props.draftKey ? sessionSettings?.beginSettlement(props.draftKey) : undefined;
      settlementRef.current = settlement;
      return () => {
        releaseAttachments();
        settlement?.release();
        if (settlementRef.current === settlement) settlementRef.current = undefined;
      };
    },
    pendingAttachments: staging.pendingAttachments,
    onRemoveAttachment: staging.removeAttachment,
    onPickAttachments: contextPickEnabled ? staging.pickAttachments : undefined,
    onAttachFilePaths: contextPickEnabled ? staging.attachFilePaths : undefined,
    ...staging.composerQuoteProps(canStageContext),
    ...staging.directoryComposerProps,
    onPickDirectory: directoryPickerEnabled ? staging.directoryComposerProps.onPickDirectory : undefined,
  } : {})} />;
}
