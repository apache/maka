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

import type { SessionHeader } from '@maka/core/session';

export function isDiscardableConversationCopy(header: SessionHeader): boolean {
  const copy = header.conversationCopy;
  return (
    copy?.state === 'preparing' ||
    (copy?.kind === 'revision' &&
      copy.state === 'committed' &&
      header.revisionState === 'preparing')
  );
}

export function isValidConversationCopyTransition(
  current: SessionHeader,
  next: SessionHeader['conversationCopy'],
): boolean {
  const previous = current.conversationCopy;
  return (
    previous !== undefined &&
    next !== undefined &&
    previous.kind === next.kind &&
    previous.sourceSessionId === next.sourceSessionId &&
    previous.sourceTurnId === next.sourceTurnId &&
    previous.requestFingerprint === next.requestFingerprint &&
    (previous.state !== 'committed' || next.state === 'committed') &&
    (previous.state !== 'preparing' || next.state === 'preparing' || next.state === 'committed')
  );
}
