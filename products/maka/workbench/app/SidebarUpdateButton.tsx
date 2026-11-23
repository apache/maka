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

import { cleanup, effect, platform, signal, Text, View } from 'nsh';
import { Button, Popover } from 'nsh/base';
import { appUpdater } from './appUpdater';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  controlHoverStyle,
  floatingStyle,
  quietFocusStyle,
  textTooltip,
} from './ui';

export function SidebarUpdateButton(props: {
  holdSidebarHover?: ((active: boolean) => void) | undefined;
}) {
  appUpdater.init();
  const open = signal(false);
  let alive = true;
  let holdingHover = false;
  const setOpen = (next: boolean) => {
    if (!alive) return;
    open.set(next);
    if (holdingHover !== next) {
      holdingHover = next;
      props.holdSidebarHover?.(next);
    }
  };
  cleanup(() => {
    alive = false;
    if (holdingHover) {
      holdingHover = false;
      props.holdSidebarHover?.(false);
    }
  });
  effect(() => {
    if (!appUpdater.sidebarVisible() || appUpdater.snapshot()?.status === 'installing') {
      if (open()) setOpen(false);
    }
  });

  const version = () => appUpdater.snapshot()?.available?.version ?? '';
  const installing = () => appUpdater.snapshot()?.status === 'installing';
  const tooltip = () => {
    if (open()) return undefined;
    if (installing()) return tr('Stopping Maka Host and applying update…');
    return version()
      ? tr('Restart to update to {version}', { version: version() })
      : tr('Restart to update');
  };
  const label = () =>
    installing()
      ? tr('Stopping Maka Host and applying update…')
      : version()
        ? tr('Restart to update to {version}', { version: version() })
        : tr('Restart to update');

  const restart = () => {
    setOpen(false);
    void appUpdater.installAndRestart().then(() => {
      const state = appUpdater.snapshot();
      if (state?.status === 'ready' && state.error) setOpen(true);
    });
  };

  return (
    <If when={platform.idiom !== 'terminal' && appUpdater.sidebarVisible()}>
      <Popover
        open={open()}
        onOpenChange={({ open: next }) => setOpen(next)}
        closeOnEscape
        closeOnPressOutside
        placement="top"
        align="end"
        offset={8}
        margin={8}
        popupStyle={{
          ...floatingStyle(),
          width: 272,
          padding: 12,
          gap: 10,
        }}
        trigger={
          <Button
            accessibilityLabel={label()}
            tooltip={textTooltip(tooltip)}
            disabled={installing()}
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              flexShrink: 0,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: C.accent,
            }}
            hoverStyle={{ backgroundColor: C.accentHover }}
            focusStyle={quietFocusStyle()}
            activeStyle={{ opacity: 0.85 }}
          >
            <If when={installing()} else={<Icon name="download" size={15} color={C.background} />}>
              <LoadingIndicator
                size={15}
                color={C.background}
                label={tr('Stopping Maka Host and applying update…')}
              />
            </If>
          </Button>
        }
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <Text
            style={[
              { fontSize: 13, lineHeight: 18, fontWeight: '600', color: C.text, flexShrink: 1 },
              { numberOfLines: 1, textOverflow: 'ellipsis' },
            ]}
          >
            {version() ? `Maka ${version()}` : tr('Restart to update')}
          </Text>
          <If when={appUpdater.snapshot()?.channel === 'nightly'}>
            <Text style={{ fontSize: 11, lineHeight: 16, color: C.muted, flexShrink: 0 }}>
              Nightly
            </Text>
          </If>
        </View>
        <Text style={{ ...captionTextStyle, lineHeight: 18, color: C.secondary }}>
          {tr(
            'Update {version} is ready. Maka Host will restart to apply it; active runs resume automatically.',
            { version: version() },
          )}
        </Text>
        <If when={!!appUpdater.snapshot()?.error}>
          <Text style={{ ...captionTextStyle, lineHeight: 18, color: C.danger }}>
            {appUpdater.snapshot()?.error ?? ''}
          </Text>
        </If>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}
        >
          <Button
            accessibilityLabel={tr('Later')}
            onPress={() => setOpen(false)}
            style={{
              height: 28,
              paddingHorizontal: 10,
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Later')}</Text>
          </Button>
          <Button
            accessibilityLabel={tr('Restart to update')}
            onPress={restart}
            style={{
              height: 28,
              paddingHorizontal: 10,
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: C.accent,
            }}
            hoverStyle={{ backgroundColor: C.accentHover }}
            focusStyle={quietFocusStyle()}
            activeStyle={{ opacity: 0.85 }}
          >
            <Text style={{ ...captionTextStyle, fontWeight: '500', color: C.background }}>
              {tr('Restart to update')}
            </Text>
          </Button>
        </View>
      </Popover>
    </If>
  );
}
