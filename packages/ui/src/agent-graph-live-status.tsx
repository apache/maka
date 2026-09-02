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

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { Spinner } from '@astryxdesign/core/Spinner';

/** `mm:ss`, or `h:mm:ss` once an hour is on the clock. Locale-neutral digits. */
function formatElapsed(totalSeconds: number): string {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Live badge for a long-running graph view: a heartbeat spinner plus an
 * elapsed stopwatch measured from the graph epoch's `createdAt`, wrapped
 * around the row's own status content. Decorative throughout — the status
 * text beside it carries the announcement, so nothing here is labelled.
 */
export function AgentGraphLiveStatus(props: {
  readonly live: boolean;
  readonly startedAt?: number;
  readonly children?: ReactNode;
}): JSX.Element {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    if (!props.live) {
      setNow(undefined);
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [props.live]);

  const elapsedSeconds =
    props.startedAt === undefined || now === undefined
      ? undefined
      : Math.max(0, Math.floor((now - props.startedAt) / 1000));

  return (
    <>
      {props.live ? (
        <Spinner size="sm" shade="subtle" className="maka-agent-graph-heartbeat" aria-hidden="true" />
      ) : null}
      {props.children}
      {elapsedSeconds !== undefined ? (
        <span className="maka-agent-graph-elapsed" aria-hidden="true">
          {' · '}
          {formatElapsed(elapsedSeconds)}
        </span>
      ) : null}
    </>
  );
}
