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
import type { ComputerHistoryApplication } from '@maka/core/computer-history';
import { historyAppName } from './computer-history-copy.js';

export function ComputerHistoryAppIcon({ application, metadata, size = 20 }: {
  application: string; metadata?: ComputerHistoryApplication; size?: number;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = metadata?.iconDataUrl;
  const name = historyAppName(application, metadata?.name);
  return <span aria-hidden className="computer-history-app-icon" style={{ width: size, height: size }}>
    {source?.startsWith('data:image/png;base64,') && source !== failedSource
      ? <img src={source} alt="" width={size} height={size} onError={() => setFailedSource(source)} />
      : <span className="computer-history-app-initial">{Array.from(name)[0]?.toLocaleUpperCase() || '?'}</span>}
  </span>;
}
