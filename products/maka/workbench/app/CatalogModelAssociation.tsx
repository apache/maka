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

import { cleanup, inputAction, keymap, List, signal, Text, windowSize, type ListRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import type { CatalogModelReference } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ModelAction, ModelSettingsOwner } from './settings';
import type { ServiceMethods } from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from './locale';
import { errorText, renderText } from './text';
import { SettingsButton, SettingsRow } from './SettingsPage';
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
    <>
      <SettingsRow
        label={tr('Catalog model')}
        description={
          reference()
            ? `${reference()!.provider} / ${reference()!.modelId}`
            : tr('Automatic matching')
        }
        status={
          owner.model()?.defaults?.catalogMatched === false
            ? reference()
              ? tr('Associated catalog model is unavailable.')
              : tr('No catalog model matched.')
            : undefined
        }
        trailing={
          <>
            <If when={reference()}>
              <SettingsButton
                label={tr('Automatic matching')}
                accessibilityLabel={tr('Clear catalog association')}
                tone="quiet"
                disabled={props.disabled}
                onPress={() =>
                  owner.chooseCatalogModel({ ...owner.modelAction(), reference: null })
                }
              />
            </If>
            <SettingsButton
              label={tr('Choose model')}
              accessibilityLabel={tr('Associate catalog model')}
              disabled={props.disabled}
              onPress={inputAction(
                (request: ModelAction) => opened.set(request),
                owner.modelAction(),
              )}
            />
          </>
        }
      />
      <If when={opened()}>
        <CatalogModelPicker settings={owner} request={opened()!} close={() => opened.set(null)} />
      </If>
    </>
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
      if (!more && result.models.length) list?.scrollToIndex({ index: 0, animated: false });
    } catch (reason) {
      if (alive && request === generation)
        failure.set(renderText(errorText(reason, 'Could not load models.')));
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
    <ModalDialog size="form" height={windowSize().height * 0.75} onCancel={props.close}>
      <DialogHeader title={tr('Associate catalog model')} />
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
      <DialogFooter>
        <If when={after() || failure()}>
          <SettingsButton
            label={loading() ? tr('Loading…') : failure() ? tr('Retry') : tr('Load more')}
            disabled={loading()}
            onPress={() => void search(query(), !!after())}
          />
        </If>
        <SettingsButton
          label={tr('Close')}
          accessibilityLabel={tr('Close catalog models')}
          onPress={props.close}
        />
      </DialogFooter>
    </ModalDialog>
  );
}
