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

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
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
 * elapsed stopwatch wrapped around the row's own status content. The stopwatch
 * measures this view's observation of the live graph — the carried snapshot
 * has no start timestamp — and resets whenever `resetKey` changes or `live`
 * drops, so a stale clock never survives a selection change.
 */
export function AgentGraphLiveStatus(props: {
  readonly live: boolean;
  readonly resetKey: string;
  readonly label: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState<number>();
  const liveSinceRef = useRef<{ resetKey: string; at: number } | undefined>(undefined);

  useEffect(() => {
    if (!props.live) {
      liveSinceRef.current = undefined;
      setElapsedSeconds(undefined);
      return;
    }
    if (liveSinceRef.current?.resetKey !== props.resetKey) {
      liveSinceRef.current = { resetKey: props.resetKey, at: Date.now() };
    }
    const startedAt = liveSinceRef.current.at;
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [props.live, props.resetKey]);

  return (
    <>
      {props.live ? (
        <Spinner
          size="sm"
          shade="subtle"
          className="maka-agent-graph-heartbeat"
          aria-label={props.label}
        />
      ) : null}
      {props.children}
      {props.live && elapsedSeconds !== undefined ? (
        <span className="maka-agent-graph-elapsed" aria-hidden="true">
          {' · '}
          {formatElapsed(elapsedSeconds)}
        </span>
      ) : null}
    </>
  );
}
