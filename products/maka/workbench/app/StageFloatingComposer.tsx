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

import { signal, Text, View, windowSize, type JSX } from 'nsh';
import { Button, Input } from 'nsh/base';
import { hasComposerContent } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { DraftQuotes } from '../../../../plugins/agent/composer/ui/DraftQuotes';
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { Icon } from './Icon';
import { tr } from './locale';
import { toast } from './toastStore';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  controlDisabledStyle,
  controlStyle,
  floatingShadow,
  lineWidth,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  radius,
  textTooltip,
} from './ui';

const MAX_INPUT_HEIGHT = 88;

/**
 * Floating mini-conversation and follow-up composer shown at the bottom center
 * of the Workspace Stage when in Fullscreen mode.
 */
export function StageFloatingComposer(props: {
  title(): string;
  session(): ComposerSession<JSX.Element> | null;
  stop(): void;
  exitFullscreen(): void;
  transcript(): JSX.Element | null;
}) {
  let followupInput: { focus(): void } | null = null;
  const expanded = signal(false);
  const minimized = signal(false);
  const inputHeight = signal(20);

  const running = () => (props.session()?.run() ?? null) !== null;
  const draft = () => props.session()?.draft() ?? '';
  const canSend = () => {
    const session = props.session();
    if (!session || !session.editable()) return false;
    return hasComposerContent(
      session.draft().trim(),
      session.attachments.files(),
      session.quotes(),
    );
  };

  const send = () => {
    const session = props.session();
    if (!session || !canSend()) return;
    const text = session.draft();
    if (text.startsWith('/')) {
      props.exitFullscreen();
      return;
    }
    const block = session.sendBlock();
    if (block) {
      toast.show({ id: 'stage-composer.refused', tone: 'warning', message: block.message });
      return;
    }
    session.submit({ text });
  };

  return (
    <View
      style={{
        width: '100%',
        maxWidth: 560,
        borderRadius: radius(16),
        backgroundColor: C.floating,
        borderWidth: lineWidth(),
        borderColor: C.line,
        boxShadow: floatingShadow(`0 8px 24px ${C.shadow}`),
        overflow: 'hidden',
      }}
    >
      {/* Top conversation title pill bar */}
      <View
        style={{
          height: 36,
          paddingHorizontal: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <Button
          accessibilityLabel={minimized() ? tr('Expand conversation') : tr('Collapse conversation')}
          tooltip={textTooltip(() =>
            minimized() ? tr('Expand conversation') : tr('Collapse conversation'),
          )}
          onPress={() => {
            if (expanded()) expanded.set(false);
            else minimized.set(!minimized());
          }}
          style={{
            ...controlStyle(),
            width: 28,
            minHeight: 28,
            height: 28,
            paddingHorizontal: 0,
            paddingVertical: 0,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name={minimized() ? 'up' : 'minus'} size={14} color={C.muted} />
        </Button>

        <Button
          accessibilityLabel={expanded() ? tr('Collapse conversation') : tr('Expand conversation')}
          onPress={() => {
            minimized.set(false);
            expanded.set(!expanded());
          }}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 28,
            height: 28,
            paddingHorizontal: 8,
            borderRadius: radius(8),
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 8,
          }}
          hoverStyle={quietHoverStyle()}
          activeStyle={quietActiveStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon
            name={running() ? 'statusRecorded' : 'conversation'}
            size={14}
            color={running() ? C.accentText : C.muted}
          />
          <Text
            style={[
              {
                ...captionTextStyle,
                color: C.text,
                fontWeight: '500',
                flexShrink: 1,
                minWidth: 0,
              },
              { numberOfLines: 1 },
            ]}
          >
            {props.title() || tr('Untitled conversation')}
          </Text>
          <Icon name={expanded() ? 'down' : 'up'} size={12} color={C.muted} />
        </Button>

        <Button
          accessibilityLabel={tr('Exit fullscreen')}
          tooltip={textTooltip(() => tr('Exit fullscreen'))}
          onPress={props.exitFullscreen}
          style={{
            ...controlStyle(),
            width: 28,
            minHeight: 28,
            height: 28,
            paddingHorizontal: 0,
            paddingVertical: 0,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name="minimize" size={14} color={C.muted} />
        </Button>
      </View>

      {/* Expandable live mini-conversation exchange */}
      <If when={expanded() && !minimized()}>
        <View
          style={{
            maxHeight: Math.min(280, Math.max(120, windowSize().height - 168)),
            minHeight: 0,
            flexShrink: 1,
            borderTopWidth: 1,
            borderTopColor: C.line,
            paddingHorizontal: 8,
            paddingVertical: 4,
            backgroundColor: C.panel,
          }}
        >
          {props.transcript()}
        </View>
      </If>

      <If when={!minimized() && (props.session()?.quotes().length ?? 0) > 0}>
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <DraftQuotes owner={props.session()!} />
        </View>
      </If>

      {/* Follow-up input bar */}
      <If when={!minimized()}>
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: C.line,
            paddingHorizontal: 12,
            paddingVertical: 8,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Button
            accessibilityLabel={tr('Add to message')}
            tooltip={textTooltip(() => tr('Add to message'))}
            onPress={props.exitFullscreen}
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            hoverStyle={{ backgroundColor: C.floatingRaised }}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="plus" size={15} color={C.muted} />
          </Button>
          <View
            role="button"
            accessibilityLabel={tr('Ask a follow-up')}
            onPress={() => followupInput?.focus()}
            style={{
              position: 'absolute',
              top: 0,
              right: 44,
              bottom: 0,
              left: 44,
            }}
          />
          <Input
            ref={(node) => {
              followupInput = node;
            }}
            multiline
            submitBehavior="submit"
            accessibilityLabel={tr('Message composer')}
            placeholder={tr('Ask a follow-up')}
            value={draft()}
            readonly={!(props.session()?.editable() ?? false)}
            onChange={({ value }) => {
              props.session()?.changeDraft(value);
            }}
            onSubmit={send}
            onContentSizeChange={({ size }) =>
              inputHeight.set(Math.max(20, Math.min(size.height, MAX_INPUT_HEIGHT)))
            }
            style={{
              ...bodyTextStyle,
              flex: 1,
              minWidth: 0,
              height: inputHeight(),
              color: C.text,
            }}
          />
          <Button
            accessibilityLabel={running() ? tr('Stop response') : tr('Send message')}
            disabled={!running() && !canSend()}
            onPress={running() ? props.stop : send}
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: running() ? C.text : canSend() ? C.accent : C.raised,
            }}
            hoverStyle={{ opacity: 0.9 }}
            focusStyle={quietFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon
              name={running() ? 'stop' : 'send'}
              size={14}
              color={running() ? C.chrome : canSend() ? C.onAccent : C.muted}
            />
          </Button>
        </View>
      </If>
    </View>
  );
}
