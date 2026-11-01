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

import {
  cleanup,
  inputAction,
  keymap,
  List,
  signal,
  Text,
  View,
  windowSize,
  type ListRef,
} from 'nsh';
import { Button, Dialog, Input } from 'nsh/base';
import type { CatalogModelReference } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ModelAction, ModelSettingsOwner } from './settings';
import type { ServiceMethods } from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from './locale';
import { errorText, renderText } from './text';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

type CatalogModel = ServiceMethods['settings']['catalogModels']['output']['models'][number];

export function CatalogModelAssociation(props: {
  settings: ModelSettingsOwner;
  disabled: boolean;
}) {
  const owner = props.settings;
  const opened = signal<ModelAction | null>(null);
  const reference = () => owner.model()?.catalogModel;
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ ...captionTextStyle, color: C.secondary, fontWeight: '500' }}>
        {tr('Catalog model')}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1, minWidth: 160, gap: 4 }}>
          <Text
            style={{
              ...captionTextStyle,
              color: C.text,
              numberOfLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {reference()
              ? `${reference()!.provider} / ${reference()!.modelId}`
              : tr('Automatic matching')}
          </Text>
          <If when={owner.model()?.defaults?.catalogMatched === false}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {reference()
                ? tr('Associated catalog model is unavailable.')
                : tr('No catalog model matched.')}
            </Text>
          </If>
        </View>
        <Button
          accessibilityLabel={tr('Associate catalog model')}
          disabled={props.disabled}
          onPress={inputAction((request: ModelAction) => opened.set(request), owner.modelAction())}
          style={controlStyle}
          hoverStyle={controlHoverStyle()}
          activeStyle={{ backgroundColor: C.line }}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Choose model')}</Text>
        </Button>
        <If when={reference()}>
          <Button
            accessibilityLabel={tr('Clear catalog association')}
            disabled={props.disabled}
            onPress={inputAction(owner.chooseCatalogModel, {
              ...owner.modelAction(),
              reference: null,
            })}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            activeStyle={{ backgroundColor: C.line }}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {tr('Automatic matching')}
            </Text>
          </Button>
        </If>
      </View>
      <If when={opened()}>
        <CatalogModelPicker settings={owner} request={opened()!} close={() => opened.set(null)} />
      </If>
    </View>
  );
}

function CatalogModelPicker(props: {
  settings: ModelSettingsOwner;
  request: ModelAction;
  close(): void;
}) {
  const query = signal('');
  const models = signal<CatalogModel[]>([]);
  const after = signal<CatalogModelReference | null>(null);
  const loading = signal(false);
  const failure = signal('');
  const selected = signal(0);
  let alive = true;
  let generation = 0;
  let list: ListRef | undefined;
  let removeKeys = () => {};
  cleanup(() => {
    alive = false;
    removeKeys();
  });
  const search = async (text: string, more = false) => {
    if (more && (loading() || !after())) return;
    const request = ++generation;
    const cursor = more ? after() : null;
    query.set(text);
    failure.set('');
    loading.set(true);
    if (!more) {
      models.set([]);
      after.set(null);
      selected.set(0);
    }
    try {
      const result = await props.settings.readCatalogModels(text, cursor);
      if (!alive || request !== generation) return;
      models.set(more ? [...models(), ...result.models] : result.models);
      after.set(result.after);
      if (!more) list?.scrollToIndex({ index: 0, animated: false });
    } catch (reason) {
      if (alive && request === generation) failure.set(renderText(errorText(reason)));
    } finally {
      if (alive && request === generation) loading.set(false);
    }
  };
  const choose = (reference: CatalogModelReference) => {
    if (!alive || props.settings.busy()) return;
    props.settings.chooseCatalogModel({ ...props.request, reference });
    props.close();
  };
  const move = (delta: number) => {
    if (models().length === 0) return;
    const index = Math.max(0, Math.min(models().length - 1, selected() + delta));
    selected.set(index);
    list?.scrollToIndex({ index, animated: false, viewPosition: delta > 0 ? 1 : 0 });
  };
  void search('');
  return (
    <Dialog
      animation="none"
      onOpenChange={({ open }) => {
        if (!open) props.close();
      }}
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: C.scrim,
        padding: 16,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 560,
          height: windowSize().height * 0.75,
          maxHeight: '100%',
          minHeight: 0,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 12,
          padding: 16,
          gap: 12,
        }}
      >
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
            {tr('Associate catalog model')}
          </Text>
          <Button
            accessibilityLabel={tr('Close catalog models')}
            onPress={props.close}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            activeStyle={{ backgroundColor: C.line }}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Close')}</Text>
          </Button>
        </View>
        <Input
          accessibilityLabel={tr('Search catalog models')}
          value={query()}
          placeholder={tr('Search catalog models')}
          autoFocus
          onChange={({ value }) => {
            void search(value);
          }}
          onSubmit={() => {
            const model = models()[selected()];
            if (model) choose(model.reference);
          }}
          submitBehavior="submit"
          style={{
            color: C.text,
            height: 32,
            backgroundColor: C.background,
            paddingHorizontal: 12,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: 8,
            ...captionTextStyle,
          }}
          focusStyle={{ borderColor: C.accent }}
          ref={(node) => {
            removeKeys();
            const keys = [
              keymap.bind('up', () => move(-1), { within: node, when: 'always', repeat: true }),
              keymap.bind('down', () => move(1), { within: node, when: 'always', repeat: true }),
              keymap.bind('escape', props.close, { within: node, when: 'always' }),
            ];
            removeKeys = () => keys.forEach((remove) => remove());
          }}
        />
        <List
          each={models()}
          estimatedItemSize={64}
          ref={(node) => {
            list = node;
          }}
          style={{ flex: 1, minHeight: 0 }}
          empty={
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {loading() ? tr('Loading…') : tr('No matches.')}
            </Text>
          }
        >
          {(item, index) => (
            <Button
              accessibilityLabel={`${item().reference.provider} / ${item().reference.modelId}`}
              selected={selected() === index()}
              disabled={props.settings.busy()}
              onPress={inputAction(choose, item().reference)}
              style={{
                ...controlStyle,
                height: 64,
                gap: 4,
                justifyContent: 'center',
                backgroundColor: selected() === index() ? C.raised : C.surface,
              }}
              hoverStyle={controlHoverStyle()}
              activeStyle={{ backgroundColor: C.line }}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text
                style={{
                  ...bodyTextStyle,
                  color: C.text,
                  numberOfLines: 1,
                  textOverflow: 'ellipsis',
                }}
              >
                {item().label}
              </Text>
              <Text
                style={{
                  ...captionTextStyle,
                  color: C.muted,
                  numberOfLines: 1,
                  textOverflow: 'ellipsis',
                }}
              >{`${item().reference.provider} / ${item().reference.modelId}`}</Text>
            </Button>
          )}
        </List>
        <If when={failure()}>
          <Text style={{ ...captionTextStyle, color: C.danger }}>{failure()}</Text>
        </If>
        <If when={after() || failure()}>
          <Button
            disabled={loading()}
            onPress={() => {
              void search(query(), !!after());
            }}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            activeStyle={{ backgroundColor: C.line }}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.text }}>
              {loading() ? tr('Loading…') : failure() ? tr('Retry') : tr('Load more')}
            </Text>
          </Button>
        </If>
      </View>
    </Dialog>
  );
}
