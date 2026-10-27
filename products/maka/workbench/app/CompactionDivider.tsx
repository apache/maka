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

import { Text, View } from 'nsh';
import { tr } from './locale';
import { C, captionTextStyle } from './ui';

export function CompactionDivider(props: { durationMs?: () => number }) {
  const duration = (milliseconds: number) => {
    const seconds = milliseconds / 1000;
    return seconds < 60
      ? `${seconds.toFixed(1)}s`
      : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  };
  const label = () => {
    const milliseconds = props.durationMs?.();
    return milliseconds === undefined
      ? tr('Compacting context…')
      : tr('Context compacted ({duration})', { duration: duration(milliseconds) });
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        width: '100%',
      }}
    >
      <View style={{ flex: 1, borderTopWidth: 1, borderTopColor: C.line }} />
      <Text style={{ color: C.muted, ...captionTextStyle }}>{label()}</Text>
      <View style={{ flex: 1, borderTopWidth: 1, borderTopColor: C.line }} />
    </View>
  );
}
