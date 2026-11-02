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

import { cleanup, inputAction, signal, Text, View } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { tr } from './locale';
import { Icon } from './Icon';
import { dialogTop } from './chrome';
import {
  C,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  textTooltip,
  toolbarControlStyle,
} from './ui';
import { errorText, renderText } from './text';

/**
 * Starts the Bot over. A Session's tools are fixed when it is created, so a Bot made by an
 * older build never gains the tools of a newer one; this archives it and opens a new one.
 * It asks first because the new Bot starts without the old one's checklist and schedule.
 */
export function BotRestart(props: { restart(): Promise<void> }) {
  const asking = signal(false);
  const pending = signal(false);
  const error = signal<unknown>(null);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const confirm = async () => {
    if (pending()) return;
    pending.set(true);
    error.set(null);
    try {
      await props.restart();
      if (alive) asking.set(false);
    } catch (reason) {
      if (alive) error.set(reason);
    } finally {
      if (alive) pending.set(false);
    }
  };
  const cancel = () => {
    if (pending()) return;
    asking.set(false);
    error.set(null);
  };
  return (
    <>
      <Button
        accessibilityLabel={tr('Start the Bot over')}
        tooltip={textTooltip(() => tr('Start the Bot over'))}
        onPress={inputAction(() => asking.set(true), null)}
        style={{ ...toolbarControlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
        hoverStyle={{ backgroundColor: C.surface }}
        focusStyle={{ backgroundColor: C.raised }}
      >
        <Icon name="refresh" color={C.secondary} />
      </Button>
      <If when={asking()}>
        <Dialog
          animation="none"
          closeOnEscape={false}
          closeOnBackdropPress={false}
          closeOnSwipe={false}
          onCancel={cancel}
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
            paddingTop: dialogTop(16),
            backgroundColor: C.scrim,
          }}
        >
          <View
            style={{
              width: '100%',
              maxWidth: 480,
              padding: 16,
              gap: 12,
              backgroundColor: C.surface,
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: 16,
            }}
          >
            <Text style={{ color: C.text, fontWeight: '500' }}>{tr('Start the Bot over?')}</Text>
            <Text style={{ color: C.muted }}>
              {tr(
                'This opens a new Bot. The current Bot is archived with its conversation. Its checklist and scheduled tasks are not carried over.',
              )}
            </Text>
            <If when={error() !== null}>
              <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>
                {renderText(errorText(error()))}
              </Text>
            </If>
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
              <Button
                disabled={pending()}
                accessibilityLabel={tr('Keep the current Bot')}
                onPress={inputAction(cancel, null)}
                style={controlStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ color: C.text }}>{tr('Keep the current Bot')}</Text>
              </Button>
              <Button
                disabled={pending()}
                accessibilityLabel={tr('Start over')}
                onPress={inputAction(confirm, null)}
                style={controlStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ color: C.danger }}>
                  {pending() ? tr('Starting over…') : tr('Start over')}
                </Text>
              </Button>
            </View>
          </View>
        </Dialog>
      </If>
    </>
  );
}
