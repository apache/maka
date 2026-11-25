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

import { View, token } from 'nsh';

export type StatusKind = 'online' | 'working' | 'waiting' | 'offline' | 'error';

export function StatusDot(props: { kind: StatusKind; size?: number }) {
  const size = () => props.size ?? 8;
  const color = () => {
    switch (props.kind) {
      case 'online':
        return token('success');
      case 'working':
        return token('primary');
      case 'waiting':
        return token('warning');
      case 'error':
        return token('destructive');
      case 'offline':
        return token('offline');
    }
  };
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: size(),
        height: size(),
        borderRadius: size() / 2,
        backgroundColor: color(),
      }}
    />
  );
}
