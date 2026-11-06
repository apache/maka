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

import { computed, Text, View } from 'nsh';
import { SkillInput } from './SkillInput';
import { SourceText } from './SourceText';
import { hasSkillToken, skillTextGroups } from './skillTokenText';
import { C, bodyTextStyle } from './ui';
import type { Row } from './history';

/** Message selection uses the same atom model and source serializer as the composer. */
export function SkillMessage(props: { row(): Row; sourceId: string }) {
  const fragments = () => props.row().fragments ?? [{ offset: 0, text: props.row().text }];
  const groups = computed(() => skillTextGroups(fragments()));
  const hasSkills = computed(() => groups().some(hasSkillToken));
  return (
    <If
      when={hasSkills()}
      else={
        <Text style={[{ color: C.text, ...bodyTextStyle }, { userSelect: 'text' }]}>
          <SourceText row={props.row} sourceId={props.sourceId} />
        </Text>
      }
    >
      <View style={{ width: '100%', minWidth: 0 }}>
        <Each of={groups()} key={(group) => group.offset}>
          {(group) => (
            <SkillInput
              accessibilityLabel={group().text}
              value={group().text}
              readonly
              autoFocus={false}
              placeholder=""
              sourceId={props.sourceId}
              sourceOffset={group().offset}
              style={{ width: '100%', minWidth: 0, flexShrink: 0 }}
            />
          )}
        </Each>
      </View>
    </If>
  );
}
