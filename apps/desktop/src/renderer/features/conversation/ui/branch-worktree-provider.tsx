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

import { useEffect, useState, type ReactNode } from 'react';
import { TurnBranchWorktreeProvider } from '@maka/ui';
import type { ComposerSubmissionServices } from '../submission-services.js';

export function BranchWorktreeProvider(props: {
  services: ComposerSubmissionServices;
  sessionId?: string;
  sessionRevision?: number;
  children: ReactNode;
}) {
  const [workspace, setWorkspace] = useState<{ sessionId: string; canCreate: boolean }>();
  const { sessionId, sessionRevision, services } = props;
  useEffect(() => {
    if (!sessionId || !services.readBranchWorkspace) return;
    let live = true;
    void services.readBranchWorkspace(sessionId).then(
      (result) => {
        if (live) setWorkspace({ sessionId, canCreate: result.canCreate });
      },
      () => {
        if (live) setWorkspace({ sessionId, canCreate: false });
      },
    );
    return () => { live = false; };
  }, [sessionId, sessionRevision, services]);
  return (
    <TurnBranchWorktreeProvider value={workspace?.sessionId === sessionId && workspace?.canCreate === true}>
      {props.children}
    </TurnBranchWorktreeProvider>
  );
}
