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
import { Button } from 'nsh/base';
import { appUpdater } from './appUpdater';
import { tr } from './locale';
import { bodyTextStyle, C, controlFocusStyle, controlHoverStyle, controlStyle } from './ui';

export function UpdateBanner() {
  appUpdater.init();
  const message = () => {
    const state = appUpdater.snapshot();
    if (!state) return '';
    const version = state.available?.version ?? '';
    switch (state.status) {
      case 'available':
        return state.channel === 'nightly'
          ? tr('Nightly update {version} is available (unofficial developer build).', { version })
          : tr('Maka {version} is available.', { version });
      case 'downloading': {
        const pct = appUpdater.progressPercent();
        return pct === null
          ? tr('Downloading update {version}…', { version })
          : tr('Downloading update {version}… {percent}%', { version, percent: String(pct) });
      }
      case 'ready':
        return tr(
          'Update {version} is ready. Maka Host will restart to apply it; active runs resume automatically.',
          { version },
        );
      case 'installing':
        return tr('Stopping Maka Host and applying update…');
      default:
        return '';
    }
  };

  return (
    <If when={appUpdater.bannerVisible()}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 16,
          paddingVertical: 6,
          backgroundColor: C.chrome,
          borderTopWidth: 1,
          borderTopColor: C.line,
        }}
      >
        <Text style={{ ...bodyTextStyle, flex: 1, color: C.text }}>{message()}</Text>
        <If when={appUpdater.snapshot()?.status === 'available'}>
          <If
            when={appUpdater.snapshot()?.canInstall === true}
            else={
              <Button
                accessibilityLabel={tr('Open download')}
                onPress={() => void appUpdater.openDownload()}
                style={controlStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                activeStyle={{ backgroundColor: C.line }}
              >
                <Text style={{ ...bodyTextStyle, color: C.accent }}>{tr('Open download')}</Text>
              </Button>
            }
          >
            <Button
              accessibilityLabel={tr('Download update')}
              onPress={() => void appUpdater.download()}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              activeStyle={{ backgroundColor: C.line }}
            >
              <Text style={{ ...bodyTextStyle, color: C.accent }}>{tr('Download update')}</Text>
            </Button>
          </If>
          <Button
            accessibilityLabel={tr('Later')}
            onPress={appUpdater.dismiss}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            activeStyle={{ backgroundColor: C.line }}
          >
            <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Later')}</Text>
          </Button>
        </If>
        <If when={appUpdater.snapshot()?.status === 'ready'}>
          <Button
            accessibilityLabel={tr('Restart to update')}
            onPress={() => void appUpdater.installAndRestart()}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            activeStyle={{ backgroundColor: C.line }}
          >
            <Text style={{ ...bodyTextStyle, color: C.accent }}>{tr('Restart to update')}</Text>
          </Button>
          <Button
            accessibilityLabel={tr('Later')}
            onPress={appUpdater.dismiss}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            activeStyle={{ backgroundColor: C.line }}
          >
            <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Later')}</Text>
          </Button>
        </If>
      </View>
    </If>
  );
}
