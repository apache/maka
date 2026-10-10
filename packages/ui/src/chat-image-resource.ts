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

import { useState } from 'react';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { isRemoteImageSource, type ImageDeliveryFailure } from '@maka/core/image-delivery';
import { useAttachmentImage } from './attachment-image.js';
import { useImageDelivery } from './image-delivery.js';

export type ChatImagePresentation =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly src: string }
  | { readonly kind: 'unavailable'; readonly reason: 'attachment' | 'remote' | 'redacted' | 'unsupported' }
  | { readonly kind: 'failed'; readonly reason: 'saved_bytes' | ImageDeliveryFailure };

/** Owns delivery, saved-byte and decode transitions. The component only renders this view. */
export function useChatImageResource(input: { source: string; redacted: boolean; visible: boolean }) {
  const explicit = parseAttachmentResourceRef(input.source);
  const delivery = useImageDelivery(input.source, input.visible && !explicit, !input.redacted);
  const artifactId = explicit?.artifactId ?? (delivery.status === 'ready' ? delivery.artifactId : undefined);
  const image = useAttachmentImage(input.visible && artifactId ? { artifactId } : undefined);
  const [failedSource, setFailedSource] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const source = artifactId ? image.src : undefined;
  const remote = isRemoteImageSource(input.source);
  const hiddenRemote = remote && input.redacted;
  const remotePlaceholder = input.visible && remote && !artifactId;
  let presentation: ChatImagePresentation;
  if ((source && failedSource === source) || (artifactId && image.status === 'failed'))
    presentation = { kind: 'failed', reason: 'saved_bytes' };
  else if (source) presentation = { kind: 'ready', src: source };
  else if (!input.visible) presentation = { kind: 'loading' };
  else if (explicit && image.status === 'unavailable') presentation = { kind: 'unavailable', reason: 'attachment' };
  else if (remotePlaceholder && hiddenRemote) presentation = { kind: 'unavailable', reason: 'redacted' };
  else if (remotePlaceholder && (!delivery.available || delivery.status === 'requires_confirmation'))
    presentation = { kind: 'unavailable', reason: 'remote' };
  else if (delivery.status === 'failed') presentation = { kind: 'failed', reason: delivery.reason };
  else if (delivery.status === 'pending' || artifactId) presentation = { kind: 'loading' };
  else presentation = { kind: 'unavailable', reason: 'unsupported' };

  const retry = presentation.kind === 'failed' && (!hiddenRemote || artifactId) ? () => {
    setFailedSource(undefined);
    setAttempt(value => value + 1);
    // Once saved, only reread archived bytes; never recapture an expired/deleted source.
    if (artifactId) image.retry();
    else delivery.retry();
  } : undefined;
  const openSource = remote && !hiddenRemote && (presentation.kind === 'failed' ||
    presentation.kind === 'unavailable' && presentation.reason === 'remote') ? input.source : undefined;
  return {
    presentation, attempt, retry, openSource,
    framed: !input.visible || !!source || !!artifactId || delivery.status === 'pending',
    onDecodeError: () => { if (source) setFailedSource(source); },
  };
}
