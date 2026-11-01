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

import { cleanup, platform, signal, Text, View } from 'nsh';
import { tr } from './locale';
import { C, captionTextStyle } from './ui';

type CompactionDividerProps =
  | { state: 'running'; startedAt: () => number }
  | { state: 'completed'; durationMs: () => number };

export function CompactionDivider(props: CompactionDividerProps) {
  let durationMs: () => number;
  if (props.state === 'running') {
    const startedAt = props.startedAt;
    const clock = signal(Date.now());
    const timer = setInterval(() => clock.set(Date.now()), 1000);
    cleanup(() => clearInterval(timer));
    durationMs = () => Math.max(0, clock() - startedAt());
  } else {
    durationMs = props.durationMs;
  }
  const duration = (milliseconds: number) => {
    const seconds = milliseconds / 1000;
    return seconds < 60
      ? `${seconds.toFixed(1)}s`
      : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  };
  const label = () =>
    tr(
      props.state === 'running'
        ? 'Compacting context… ({duration})'
        : 'Context compacted ({duration})',
      { duration: duration(durationMs()) },
    );
  return <NoteDivider label={label()} />;
}

/** A quiet line across the conversation for something the Host did, not a message. */
export function NoteDivider(props: { label: string }) {
  // The terminal draws a border as a line of cells; the desktop paints no
  // zero-height border, so there the line is a filled point.
  const lineStyle = platform.isTerminal
    ? { flex: 1, borderTopWidth: 1, borderTopColor: C.line }
    : { flex: 1, height: 1, backgroundColor: C.line };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        width: '100%',
        flexShrink: 0,
      }}
    >
      <View style={lineStyle} />
      <Text
        style={[
          { color: C.muted, ...captionTextStyle, flexShrink: 1 },
          { numberOfLines: 1, textOverflow: 'ellipsis' },
        ]}
      >
        {props.label}
      </Text>
      <View style={lineStyle} />
    </View>
  );
}
