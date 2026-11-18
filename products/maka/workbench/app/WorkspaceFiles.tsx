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
import { Button, Input } from 'nsh/base';
import { NativeFileTree } from './NativeFileTree';
import { Icon } from './Icon';
import { C, captionTextStyle, quietFocusStyle, quietHoverStyle } from './ui';
import { tr } from './locale';
import type { WorkspaceFilesModel } from './workspaceFileState';

export function WorkspaceFiles(props: { model: WorkspaceFilesModel }) {
  const model = props.model;
  const status = () =>
    model.error() ||
    (model.items().length
      ? ''
      : !model.sessionId()
        ? tr('Select a conversation to browse its workspace.')
        : model.loading()
          ? tr('Loading files…')
          : model.query().trim()
            ? tr('No matching files.')
            : tr('This directory is empty.'));
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 4 }}>
      <View
        style={{
          height: 30,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 6,
        }}
      >
        <Icon name="search" size={13} color={C.muted} />
        <Input
          value={model.query()}
          onChange={({ value }) => model.query.set(value)}
          placeholder={tr('Search files…')}
          accessibilityLabel={tr('Search files…')}
          style={{ ...captionTextStyle, flex: 1, minWidth: 0, color: C.text }}
        />
        <If when={!!model.query()}>
          <Button
            accessibilityLabel={tr('Clear')}
            onPress={() => model.query.set('')}
            style={{ padding: 4 }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="close" size={13} color={C.muted} />
          </Button>
        </If>
        <Button
          accessibilityLabel={tr('Refresh workspace files')}
          onPress={model.refresh}
          style={{ padding: 4 }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name="refresh" size={13} color={C.muted} />
        </Button>
      </View>
      <If when={!!status()}>
        <Text
          style={{ ...captionTextStyle, padding: 6, color: model.error() ? C.danger : C.muted }}
        >
          {status()}
        </Text>
      </If>
      <NativeFileTree
        label={tr('Files')}
        items={model.items()}
        expanded={model.expanded()}
        setExpanded={model.setExpanded}
        open={model.open}
        demand={model.demand}
        detail={(id) => (
          <If when={!!model.note(id)}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{model.note(id)}</Text>
          </If>
        )}
      />
    </View>
  );
}
