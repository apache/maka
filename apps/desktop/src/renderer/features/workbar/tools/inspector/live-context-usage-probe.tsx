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

import { useWorkbarServices } from '../../services-context.js';
import type { ReactElement, ReactNode } from 'react';
import type { LiveContextUsage } from '../../../../application/contracts/session-inspector/live-context-usage.js';
import { useLiveContextUsage } from '../../../../application/contracts/session-inspector/use-live-context-usage.js';

/**
 * Render-prop boundary for the composer context gauge (#4717).
 *
 * The live reading needs a subscription and state, and both live here — in
 * the feature that owns the inspector's context snapshot — so the shell only
 * renders the reading, the same division of labour as the goal projection's
 * render-prop consumer around the same composer. `undefined` means the
 * snapshot cannot vouch for the composer's active route; the caller falls
 * back to the per-turn anchor.
 */
export function LiveContextUsageProbe(props: {
  readonly sessionId: string | undefined;
  readonly model: string | undefined;
  readonly providerType: string | undefined;
  readonly children: (usage: LiveContextUsage | undefined) => ReactNode;
}): ReactElement {
  const { inspector } = useWorkbarServices();
  const usage = useLiveContextUsage({
    inspector,
    sessionId: props.sessionId,
    model: props.model,
    providerType: props.providerType,
  });
  return <>{props.children(usage)}</>;
}
