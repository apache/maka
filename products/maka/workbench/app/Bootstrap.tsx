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

import { Canvas, mount, platform, reduceMotion, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { Window } from 'nsh/desktop';
import { TITLE_BAR_HEIGHT, WINDOW_MIN_SIZE } from './chrome';
import { delayed } from './delayed';
import { createPlugins } from './plugins/registry';
import { PluginInstances, renderContribution } from './plugins/RuntimeView';
import { errorText, renderText } from './text';
import { tr } from './locale';
import { installWorkbenchLocaleCatalog } from './localeCatalog';
import { initializeAppearance } from './appearance';
import { initializeComposerToolbar } from './composerToolbar';
import { initializeSidebarPreferences } from './sidebarPreferences';
import { C, controlFocusStyle, controlHoverStyle, controlStyle, lineWidth } from './ui';
import { LOADING_DELAY_MS, LoadingState } from './Loading';
import { nativeDesktop } from './nativeDesktop';

function BrandBootState() {
  if (platform.idiom === 'terminal') return <LoadingState />;
  const shown = delayed(() => true, LOADING_DELAY_MS);
  const size = 40;
  return (
    <If when={shown()}>
      <View
        role="progressbar"
        accessibilityLabel={tr('Loading…')}
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          animationName: reduceMotion() ? 'none' : 'pulse',
          animationDuration: 2000,
          animationTimingFunction: 'ease-in-out',
          animationIterationCount: 'infinite',
          animationFrameRate: 24,
        }}
      >
        <Canvas
          accessibilityElementsHidden
          style={[{ width: size, height: size }, { pointerEvents: 'none' }]}
          draw={(cx) => {
            cx.scale(size / 18, size / 18);
            cx.strokeStyle = C.secondary;
            cx.lineWidth = 1.75;
            cx.lineCap = 'round';
            cx.lineJoin = 'round';
            cx.beginPath();
            cx.moveTo(2.7, 15.6);
            cx.lineTo(9, 6);
            cx.lineTo(15.3, 15.6);
            cx.moveTo(6.165, 10.32);
            cx.lineTo(9, 14.765);
            cx.lineTo(11.835, 10.32);
            cx.moveTo(6.25, 2.4);
            cx.lineTo(11.75, 2.4);
            cx.stroke();
          }}
        />
      </View>
    </If>
  );
}

function Bootstrap() {
  installWorkbenchLocaleCatalog();
  nativeDesktop();
  void initializeAppearance();
  initializeComposerToolbar();
  initializeSidebarPreferences();
  const plugins = createPlugins();
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <PluginInstances plugins={plugins} />
      <Each
        of={plugins.rootContribution() ? [plugins.rootContribution()!] : []}
        key={(item) => item.key}
      >
        {(item) => renderContribution(plugins, item(), { sessionId: null })}
      </Each>
      <If when={!plugins.rootContribution()}>
        <View
          style={{
            flex: 1,
            gap: 12,
            padding: 16,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: C.background,
          }}
        >
          <If when={plugins.runtime.updateError() === null && !plugins.runtime.ready()}>
            <BrandBootState />
          </If>
          <If when={plugins.runtime.updateError() !== null || plugins.runtime.ready()}>
            <Text style={{ fontSize: 14, lineHeight: 20, color: C.secondary }}>
              {plugins.runtime.updateError() !== null
                ? renderText(
                    errorText(
                      plugins.runtime.updateError(),
                      'Could not load the workbench. Retry the connection.',
                    ),
                  )
                : tr('This deployment has no root UI selected.')}
            </Text>
          </If>
          <If when={plugins.runtime.updateError() !== null}>
            <Button
              accessibilityLabel={tr('Retry')}
              onPress={plugins.runtime.retryUpdates}
              style={{ ...controlStyle(), borderWidth: lineWidth(), borderColor: C.line }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Text style={{ color: C.accentText }}>{tr('Retry')}</Text>
            </Button>
          </If>
        </View>
      </If>
    </View>
  );
}
mount(() => (
  <Window
    id="main"
    title="Maka"
    titleBar={{ style: 'hidden', height: TITLE_BAR_HEIGHT }}
    minSize={WINDOW_MIN_SIZE}
    restoreBounds
    closeOnPress={false}
  >
    <Bootstrap />
  </Window>
));
