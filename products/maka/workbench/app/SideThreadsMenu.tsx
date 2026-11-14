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

// The side questions asked about one reply, under its actions.

import { computed, inputAction, signal, Text, View, windowSize } from 'nsh';
import { Button, Popover } from 'nsh/base';
import { Icon } from './Icon';
import { tr } from './locale';
import { archiveSideThread, openSideThread, sideAnchors, sideName } from './sideThreads';
import { errorText } from './text';
import {
  C,
  captionTextStyle,
  controlDisabledStyle,
  controlStyle,
  IconButton,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';

export function SideThreadsMenu(props: { parentId: string; turnId(): string | undefined }) {
  const threads = computed(() => sideAnchors(props.parentId, props.turnId()));
  const open = signal(false);
  const busy = signal<string | null>(null);
  const error = signal('');
  const show = (id: string) => {
    open.set(false);
    openSideThread(props.parentId, id);
  };
  const archive = async (id: string) => {
    if (busy()) return;
    busy.set(id);
    error.set('');
    try {
      await archiveSideThread(props.parentId, id);
    } catch (reason) {
      error.set(String(errorText(reason, 'Could not archive the side question.')));
    } finally {
      busy.set(null);
    }
  };
  return (
    <If when={threads().length > 0}>
      <Popover
        open={open()}
        onOpenChange={({ open: value }) => {
          if (value) error.set('');
          open.set(value);
        }}
        placement="bottom"
        align="start"
        offset={4}
        margin={8}
        popupStyle={{
          width: 320,
          maxWidth: Math.max(0, windowSize().width - 16),
          maxHeight: Math.min(360, Math.max(0, windowSize().height - 16)),
          minHeight: 0,
          padding: 4,
          gap: 2,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 12,
        }}
        trigger={
          <Button
            accessibilityLabel={tr('Side questions of this reply')}
            tooltip={textTooltip(() => tr('Side questions of this reply'))}
            style={{
              ...controlStyle,
              paddingHorizontal: 8,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              flexShrink: 0,
            }}
            hoverStyle={quietHoverStyle()}
            activeStyle={quietActiveStyle()}
            focusStyle={quietFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="ask" color={C.secondary} />
            <Text style={{ color: C.secondary, fontSize: 12, lineHeight: 16 }}>
              {tr('Side questions {count}', { count: threads().length })}
            </Text>
            <Icon name="down" color={C.muted} />
          </Button>
        }
      >
        <Each of={threads()} key={(thread) => thread.sessionId}>
          {(thread) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <Button
                accessibilityLabel={sideName(thread().title) ?? tr('Not asked yet')}
                onPress={inputAction(show, thread().sessionId)}
                style={{ ...controlStyle, flex: 1, minWidth: 0, paddingHorizontal: 8 }}
                hoverStyle={quietHoverStyle()}
                activeStyle={quietActiveStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Text
                  style={[
                    {
                      ...captionTextStyle,
                      color: sideName(thread().title) ? C.text : C.muted,
                      minWidth: 0,
                      flexShrink: 1,
                    },
                    { numberOfLines: 1 },
                  ]}
                >
                  {sideName(thread().title) ?? tr('Not asked yet')}
                </Text>
              </Button>
              <IconButton
                label={tr('Archive')}
                icon="archive"
                disabled={busy() !== null}
                onPress={inputAction(archive, thread().sessionId)}
              />
            </View>
          )}
        </Each>
        <If when={error()}>
          <Text style={{ ...captionTextStyle, color: C.danger, padding: 8 }}>{error()}</Text>
        </If>
      </Popover>
    </If>
  );
}

/** The passages gathered to ask about together, above the composer. */
export function SideQuoteTray(props: {
  quotes(): readonly string[];
  busy(): boolean;
  error(): string;
  ask(): void;
  remove(index: number): void;
  clear(): void;
}) {
  return (
    <View
      style={{
        marginTop: 8,
        padding: 8,
        gap: 4,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: 12,
        backgroundColor: C.surface,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="ask" color={C.secondary} />
        <Text style={{ ...captionTextStyle, color: C.secondary, flex: 1 }}>
          {tr('{count} passages quoted', { count: props.quotes().length })}
        </Text>
        <Button
          accessibilityLabel={tr('Clear quotes')}
          onPress={() => props.clear()}
          disabled={props.busy()}
          style={{ ...controlStyle, paddingHorizontal: 8 }}
          hoverStyle={quietHoverStyle()}
          activeStyle={quietActiveStyle()}
          focusStyle={quietFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Clear quotes')}</Text>
        </Button>
        <Button
          accessibilityLabel={tr('Ask about them beside')}
          onPress={() => props.ask()}
          disabled={props.busy()}
          style={{ ...controlStyle, paddingHorizontal: 10, backgroundColor: C.card }}
          hoverStyle={quietHoverStyle()}
          activeStyle={quietActiveStyle()}
          focusStyle={quietFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>
            {props.busy() ? tr('Creating fork…') : tr('Ask about them beside')}
          </Text>
        </Button>
      </View>
      <Each
        of={props.quotes().map((text, index) => ({ text, index }))}
        key={(quote) => `${quote.index}:${quote.text}`}
      >
        {(quote) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 4 }}>
            <View style={{ width: 2, alignSelf: 'stretch', backgroundColor: C.line }} />
            <Text
              style={[
                { ...captionTextStyle, color: C.text, flex: 1, minWidth: 0, paddingLeft: 6 },
                { numberOfLines: 1 },
              ]}
            >
              {quote().text.replace(/\s+/g, ' ')}
            </Text>
            <IconButton
              label={tr('Remove quote')}
              icon="close"
              disabled={props.busy()}
              onPress={() => props.remove(quote().index)}
            />
          </View>
        )}
      </Each>
      <If when={props.error()}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{props.error()}</Text>
      </If>
    </View>
  );
}
