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

import { Scroll, Text, token, View } from 'nsh';
import { Sheet } from 'nsh/base';
import type { AgentSession } from '../../bridge';
import { tr } from '../../locale';
import { spacing, type } from '../../theme/tokens';
import { BannerNotice, GroupRow, InsetGroup } from '../../ui';
import { SheetHeader, sheetInsets } from '../../ui/SheetHeader';

export function SideQuestionList(props: {
  open: boolean;
  title: string;
  sessions: readonly AgentSession[] | null;
  error: string | null;
  onClose: () => void;
  onOpen?: (session: AgentSession) => void;
}) {
  const layout = sheetInsets();
  return (
    <Sheet
      open={props.open}
      accessibilityLabel={props.title}
      detents={['medium', 'large']}
      closeOnSwipe
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      backdropStyle={{ backgroundColor: token('scrim') }}
      popupStyle={{ backgroundColor: token('grouped-bg'), ...layout.extraGutters() }}
    >
      <SheetHeader title={props.title} action={tr('Done')} onPress={props.onClose} />
      <Scroll style={{ flex: 1 }} contentStyle={{ paddingBottom: layout.bottomPadding(), gap: 8 }}>
        <If when={props.error}>
          <View style={{ marginHorizontal: spacing.pageX }}>
            <BannerNotice tone="destructive" title={props.error!} />
          </View>
        </If>
        <If
          when={props.sessions?.length}
          else={
            <If when={!props.error}>
              <Text
                style={{
                  ...type.body,
                  color: token('muted-foreground'),
                  marginHorizontal: spacing.pageX,
                }}
              >
                {props.sessions ? tr('No side questions yet') : tr('Loading…')}
              </Text>
            </If>
          }
        >
          <InsetGroup>
            <Each of={props.sessions ?? []} key={(session) => session.id}>
              {(session, index) => (
                <GroupRow
                  title={session().title}
                  subtitle={
                    session().activity === 'waiting' ? tr('Waiting for your response') : undefined
                  }
                  accessibilityLabel={
                    session().activity === 'waiting'
                      ? tr('{title} · Waiting for your response', { title: session().title })
                      : session().title
                  }
                  chevron={!!props.onOpen}
                  divider={index() + 1 < (props.sessions?.length ?? 0)}
                  onPress={props.onOpen ? () => props.onOpen?.(session()) : undefined}
                />
              )}
            </Each>
          </InsetGroup>
        </If>
      </Scroll>
    </Sheet>
  );
}
