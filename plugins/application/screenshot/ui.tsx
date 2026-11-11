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

import { nativeComponent, openUrl, platform, signal, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import { currentWindow, displays, Window, type WindowRef } from 'nsh/desktop';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { tr } from '../../../products/maka/workbench/app/locale';

const TERMS = ['screenshot', 'capture', 'snip', 'jietu', 'jt', '截图', '截圖', '截屏'];

type Failure = { message: string; permission: boolean };

const SCREEN_RECORDING_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** The desktop shell's frozen display, which selects a region and copies it. */
const Stage = nativeComponent<{}, { ready: null; copied: null; cancel: null; failed: Failure }>(
  'maka.screenshot',
  { props: [], events: ['ready', 'copied', 'cancel', 'failed'] },
);

function Overlay(props: { finish(): void }) {
  // The stage takes the keys without activating Maka, which would bring its main window forward.
  currentWindow().focus();
  const failure = signal<Failure | null>(null);
  return (
    <View style={{ flex: 1 }}>
      <Stage
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        onCopied={props.finish}
        onCancel={props.finish}
        onFailed={(failed) => failure.set(failed)}
      />
      <If when={failure() !== null}>
        <View
          style={[
            { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
            { alignItems: 'center', justifyContent: 'center', pointerEvents: 'box-none' },
          ]}
        >
          <View
            style={{
              maxWidth: 420,
              gap: 6,
              paddingVertical: 14,
              paddingHorizontal: 18,
              borderRadius: 10,
              backgroundColor: 'rgba(20, 20, 20, 0.9)',
            }}
          >
            <Text style={{ fontSize: 14, lineHeight: 20, color: '#FFFFFF' }}>
              {failure()!.permission
                ? tr(
                    'Allow Maka under Screen & System Audio Recording in System Settings, then take the screenshot again.',
                  )
                : tr('The screenshot failed: {reason}', { reason: failure()!.message })}
            </Text>
            <If when={failure()!.permission}>
              <Button
                accessibilityLabel={tr('Open System Settings')}
                onPress={() => {
                  // The stage floats above System Settings, so it closes first.
                  props.finish();
                  void openUrl(SCREEN_RECORDING_SETTINGS);
                }}
                style={{
                  alignSelf: 'flex-start',
                  marginVertical: 4,
                  paddingVertical: 5,
                  paddingHorizontal: 12,
                  borderRadius: 6,
                  backgroundColor: '#2A8FFF',
                }}
                hoverStyle={{ backgroundColor: '#4AA0FF' }}
              >
                <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: '500', color: '#FFFFFF' }}>
                  {tr('Open System Settings')}
                </Text>
              </Button>
            </If>
            <Text style={{ fontSize: 12, lineHeight: 18, color: 'rgba(255, 255, 255, 0.6)' }}>
              {tr('Press any key to close')}
            </Text>
          </View>
        </View>
      </If>
    </View>
  );
}

/** One frozen stage per display; finishing on any of them closes them all. */
function capture() {
  const windows: WindowRef[] = [];
  const finish = () => windows.splice(0).forEach((window) => window.close());
  for (const display of displays()) {
    windows.push(
      Window.open(() => <Overlay finish={finish} />, {
        id: `maka.screenshot.${display.id}`,
        kind: 'popup',
        title: tr('Capture a screen region'),
        display: display.id,
        defaultPosition: { x: display.bounds.origin.x, y: display.bounds.origin.y },
        defaultSize: { width: display.bounds.size.width, height: display.bounds.size.height },
        activate: false,
        level: 'aboveDock',
        transparent: true,
        shadow: false,
        closeOnBlur: false,
        closeOnEscape: false,
      }),
    );
  }
}

function Screenshot(props: { input: QuickToolInput }) {
  const { input } = props;
  input.attach({
    items: () => [],
    entries: () => [
      {
        title: tr('Capture a screen region'),
        icon: 'camera',
        keywords: [tr('screenshot keyword'), ...TERMS],
        run: () => {
          // The launcher floats above everything, so it has to be gone before the screen freezes.
          input.close();
          capture();
        },
      },
    ],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = () => ({
  exports: {
    tool: {
      kind: 'view',
      contract: quickToolView.id,
      render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) =>
        platform.os === 'macos' ? <Screenshot input={input} /> : null,
    },
  },
});
