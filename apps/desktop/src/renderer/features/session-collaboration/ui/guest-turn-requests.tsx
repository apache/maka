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

import type { ReactNode } from 'react';
import {
  useGuestTurnRequests,
  type GuestComposerProjection,
} from '../controller/use-guest-turn-requests.js';

/**
 * Projects the shared composer for a Guest Session and nothing for an owned
 * one. It always renders, so switching between the two keeps one Composer and
 * its drafts.
 */
export function GuestTurnRequests(props: {
  readonly sessionId: string | undefined;
  readonly discardDraft: (draftKey: string) => void;
  readonly children: (guest: GuestComposerProjection | undefined) => ReactNode;
}) {
  return <>{props.children(useGuestTurnRequests(props.sessionId, props.discardDraft))}</>;
}
