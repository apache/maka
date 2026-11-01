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

import { mount, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { createPlugins } from './plugins/registry';
import { PluginInstances, renderContribution } from './plugins/RuntimeView';
import { errorText, renderText } from './text';
import { tr } from './locale';
import { initializeAppearance } from './appearance';
import { C } from './ui';
import { LoadingState } from './Loading';

function Bootstrap() {
  initializeAppearance();
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
            <LoadingState />
          </If>
          <If when={plugins.runtime.updateError() !== null || plugins.runtime.ready()}>
            <Text style={{ fontSize: 14, lineHeight: 20, color: C.secondary }}>
              {plugins.runtime.updateError() !== null
                ? renderText(errorText(plugins.runtime.updateError()))
                : tr('This deployment has no root UI selected.')}
            </Text>
          </If>
          <If when={plugins.runtime.updateError() !== null}>
            <Button
              accessibilityLabel={tr('Retry')}
              onPress={plugins.runtime.retryUpdates}
              style={{ padding: 8 }}
            >
              <Text style={{ color: C.accent }}>{tr('Retry')}</Text>
            </Button>
          </If>
        </View>
      </If>
    </View>
  );
}
mount(Bootstrap);
