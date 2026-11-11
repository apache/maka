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

import { cleanup, inputAction, signal, Text } from 'nsh';
import { Button } from 'nsh/base';
import { tr } from './locale';
import { Icon } from './Icon';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import { C, textTooltip, toolbarControlStyle } from './ui';
import { errorText, renderText } from './text';

/**
 * Starts the Bot over, on purpose: it archives the current Bot and opens an empty new one.
 * It is not how a Bot gets newer tools; those are derived whenever work is admitted.
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
        hoverStyle={{ backgroundColor: C.card }}
        focusStyle={{ backgroundColor: C.raised }}
      >
        <Icon name="refresh" color={C.secondary} />
      </Button>
      <If when={asking()}>
        <ModalDialog size="alert" onCancel={cancel}>
          <DialogHeader
            title={tr('Start the Bot over?')}
            detail={tr(
              'This opens a new Bot. The current Bot is archived with its conversation. Its checklist and scheduled tasks are not carried over.',
            )}
          />
          <If when={error() !== null}>
            <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>
              {renderText(errorText(error()))}
            </Text>
          </If>
          <DialogFooter>
            <SettingsButton
              label={tr('Cancel')}
              tone="quiet"
              autoFocus
              disabled={pending()}
              onPress={cancel}
            />
            <SettingsButton
              label={pending() ? tr('Starting over…') : tr('Start over')}
              accessibilityLabel={tr('Start over')}
              tone="danger"
              disabled={pending()}
              onPress={() => void confirm()}
            />
          </DialogFooter>
        </ModalDialog>
      </If>
    </>
  );
}
