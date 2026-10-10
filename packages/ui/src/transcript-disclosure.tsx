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

import { useState, type ReactNode } from 'react';
import { Icon } from '@astryxdesign/core';

/** Shared transcript disclosure for process status and settled user choices. */
export function TranscriptDisclosure(props: {
  label: ReactNode;
  children: ReactNode | ((open: boolean) => ReactNode);
  running?: boolean;
  statusBar?: boolean;
  status?: string;
  className?: string;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const open = Boolean(props.running) || manualOpen;
  const chevron = props.running ? null : <Icon icon="chevronRight" size="xsm" color="inherit" className="maka-processing-chevron" />;
  return <details className={['maka-processing-sequence', props.className].filter(Boolean).join(' ')} data-maka-transcript-boundary="" open={open}>
    <summary className="maka-processing-summary" aria-expanded={open}
      aria-disabled={props.running || undefined} tabIndex={props.running ? -1 : 0}
      onClick={(event) => { event.preventDefault(); if (!props.running) setManualOpen(!open); }}>
      {props.statusBar ? <span className="maka-turn-statusbar" data-turn-status={props.status}>{props.label}{chevron}</span>
        : <><span>{props.label}</span>{chevron}</>}
    </summary>
    <div className="maka-processing-body">{typeof props.children === 'function' ? props.children(open) : props.children}</div>
  </details>;
}
