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

import { signal, Text } from 'nsh';
import { Button } from 'nsh/base';
import { tr } from './locale';
import { formatCompactCount, formatCount } from './numberFormat';
import { bodyTextStyle, C, quietFocusStyle, quietHoverStyle, radius, textTooltip } from './ui';

export function TokenCount(props: {
  value: number;
  label?: string;
  prefix?: string;
  format?: (count: string) => string;
  style?: typeof bodyTextStyle & { color?: string };
}) {
  const exact = signal(false);
  const interactive = () => formatCompactCount(props.value) !== formatCount(props.value);
  const text = () => {
    const count =
      (props.prefix ?? '') + (exact() ? formatCount(props.value) : formatCompactCount(props.value));
    return props.format?.(count) ?? count;
  };
  const textStyle = () => ({ ...bodyTextStyle, color: C.text, ...props.style });
  const name = () => (props.label ? `${props.label}: ${text()}` : text());
  const action = () => tr(exact() ? 'Show compact token count' : 'Show exact token count');
  return (
    <If
      when={interactive()}
      else={<Text style={{ ...textStyle(), userSelect: 'text' }}>{text()}</Text>}
    >
      <Button
        accessibilityLabel={`${name()} · ${action()}`}
        tooltip={textTooltip(action)}
        onPress={() => exact.set(!exact())}
        style={{ borderRadius: radius(4), cursor: 'pointer' }}
        hoverStyle={quietHoverStyle()}
        focusStyle={quietFocusStyle()}
      >
        <Text style={textStyle()}>{text()}</Text>
      </Button>
    </If>
  );
}
