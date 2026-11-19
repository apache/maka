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

import { Button } from 'nsh/base';
import { cleanup, Text, View, type ViewRef } from 'nsh';
import type { AnswerSource } from './answerCitations';
import {
  C,
  captionTextStyle,
  quietFocusStyle,
  quietHoverStyle,
  secondaryTextStyle,
  textTooltip,
} from './ui';

export type { AnswerSource } from './answerCitations';
type OpenLink = (target: string, restoreFocus: () => boolean) => Promise<void>;

function SourceLink(props: { source(): AnswerSource; chip?: boolean; openLink: OpenLink }) {
  let ref: ViewRef | undefined;
  cleanup(() => {
    ref = undefined;
  });
  const label = () =>
    props.chip ? (props.source().site ?? props.source().title) : props.source().title;
  return (
    <Button
      ref={(node) => {
        ref = node;
      }}
      role="link"
      accessibilityLabel={label()}
      tooltip={textTooltip(() => props.source().url)}
      onPress={() => {
        const url = props.source().url;
        if (url)
          void props.openLink(url, () => {
            if (!ref) return false;
            ref.focus();
            return true;
          });
      }}
      style={
        props.chip
          ? {
              verticalAlign: 'middle',
              alignSelf: 'flex-start',
              backgroundColor: C.raised,
              borderRadius: 9,
              paddingHorizontal: 6,
              marginHorizontal: 2,
            }
          : { alignSelf: 'flex-start', maxWidth: '100%', paddingVertical: 2 }
      }
      hoverStyle={quietHoverStyle()}
      focusStyle={quietFocusStyle()}
    >
      <Text
        style={
          props.chip
            ? { fontSize: 11, lineHeight: 16, color: C.secondary }
            : { ...secondaryTextStyle, color: C.accent }
        }
      >
        {label()}
      </Text>
    </Button>
  );
}

export function SourceChip(props: { source(): AnswerSource; openLink: OpenLink }) {
  return (
    <If
      when={props.source().url}
      else={<Text style={{ ...captionTextStyle, color: C.secondary }}>{props.source().title}</Text>}
    >
      <SourceLink chip source={props.source} openLink={props.openLink} />
    </If>
  );
}

export function AnswerSourceList(props: {
  sources(): readonly AnswerSource[];
  openLink: OpenLink;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Each of={props.sources()} key={(source) => source.key}>
        {(source) => (
          <If
            when={source().url}
            else={<Text style={{ ...captionTextStyle, color: C.secondary }}>{source().title}</Text>}
          >
            <SourceLink source={source} openLink={props.openLink} />
          </If>
        )}
      </Each>
    </View>
  );
}
