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
import type { JSX } from 'nsh';
import { SkillInput } from './SkillInput';
import { MarkdownBody } from './MarkdownBody';
import { SourceText } from './SourceText';
import { hasComposerToken, skillTextGroups } from './skillTokenText';
import { hasTextPrefix, type Row } from './history';
import type { MessageSelection } from './messageSelection';
import { C, readingTextStyle } from './ui';

export function userMessagePresentation(row: Row) {
  const prefix = hasTextPrefix(row);
  if (prefix && /[\r\n]|!\[/.test(row.text)) return { kind: 'markdown' as const };
  const groups = skillTextGroups(row.fragments ?? [{ offset: 0, text: row.text }]);
  if (groups.some(hasComposerToken)) return { kind: 'tokens' as const, groups };
  // Plain messages can keep their intrinsic bubble width. A block renderer
  // needs a width up front and owns parsing the possible syntax.
  if (
    prefix &&
    /[#*_~`\[\]<>!\\&@$]|^(?: {4}|\t)|^\s*(?:[-+=]|\d+[.)])|https?:|www\./i.test(row.text)
  )
    return { kind: 'markdown' as const };
  return { kind: 'plain' as const };
}

export function SkillMessage(props: {
  row(): Row;
  presentation(): ReturnType<typeof userMessagePresentation>;
  sourceId: string;
  sessionId: string;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
  openSession?(sessionId: string): void;
  menu?(body: JSX.Element): JSX.Element;
  selection?: MessageSelection;
}) {
  const wrap = (body: JSX.Element) => (props.menu ? props.menu(body) : body);
  return (
    <If
      when={props.presentation().kind === 'markdown'}
      else={
        <If
          when={props.presentation().kind === 'tokens'}
          else={wrap(
            <View
              selectable
              onSelectionChange={(event: { text: string }) =>
                props.selection?.set(event.text, 'plain')
              }
            >
              <Text style={{ ...readingTextStyle(), color: C.text }}>
                <SourceText row={props.row} sourceId={props.sourceId} />
              </Text>
            </View>,
          )}
        >
          {wrap(
            <View style={{ width: '100%', minWidth: 0 }}>
              <Each
                of={(() => {
                  const presentation = props.presentation();
                  return presentation.kind === 'tokens' ? presentation.groups : [];
                })()}
                key={(group) => group.offset}
              >
                {(group) => (
                  <SkillInput
                    accessibilityLabel={group().text}
                    value={group().text}
                    readonly
                    onSelectionChange={({ start, end }) => {
                      const from = Math.min(start, end);
                      const to = Math.max(start, end);
                      props.selection?.set(group().text.slice(from, to), `token:${group().offset}`);
                    }}
                    onBlur={() => props.selection?.set('', `token:${group().offset}`)}
                    onOpenSessionReference={
                      props.openSession
                        ? ({ sessionId }) => props.openSession?.(sessionId)
                        : undefined
                    }
                    autoFocus={false}
                    placeholder=""
                    sourceId={props.sourceId}
                    sourceOffset={group().offset}
                    style={{ width: '100%', minWidth: 0, flexShrink: 0 }}
                  />
                )}
              </Each>
            </View>,
          )}
        </If>
      }
    >
      <MarkdownBody
        row={props.row}
        sourceId={props.sourceId}
        sessionId={props.sessionId}
        interactiveBlocks={false}
        openLink={props.openLink}
        userScroll={props.userScroll}
        menu={props.menu}
        selection={props.selection}
      />
    </If>
  );
}
