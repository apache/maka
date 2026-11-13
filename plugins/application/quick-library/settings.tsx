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

import { computed, signal, Text, type JSX, type Signal } from 'nsh';
import {
  SettingsBody,
  SettingsButton,
  SettingsRow,
  SettingsSection,
} from '../../../products/maka/workbench/app/SettingsPage';
import { SettingsField } from '../../../products/maka/workbench/app/SettingsField';
import { tr } from '../../../products/maka/workbench/app/locale';
import { C } from '../../../products/maka/workbench/app/ui';
import { errorText, renderText } from '../../../products/maka/workbench/app/text';
import { draftProblem, type LibraryDraft, type LibraryItem, type LibraryKind } from './library';

export type Library = {
  items: Signal<readonly LibraryItem[] | null>;
  failure: Signal<unknown>;
  save(next: readonly LibraryItem[]): void;
};

const sections: readonly { kind: LibraryKind; title(): string; value(): string }[] = [
  { kind: 'snippet', title: () => tr('Snippets'), value: () => tr('Content') },
  { kind: 'note', title: () => tr('Notes'), value: () => tr('Content') },
  { kind: 'link', title: () => tr('Links'), value: () => tr('URL') },
];

function Section(props: {
  section: (typeof sections)[number];
  library: Library;
  draft: Signal<LibraryDraft | null>;
}): JSX.Element {
  const { library, draft, section } = props;
  const armed = signal<string | null>(null);
  const items = computed(() =>
    (library.items() ?? []).filter((item) => item.kind === section.kind),
  );
  const editing = () => draft()?.kind === section.kind;
  const edit = (patch: Partial<LibraryDraft>) => draft.set({ ...draft()!, ...patch });
  const remove = (item: LibraryItem) => {
    if (armed() !== item.id) {
      armed.set(item.id);
      return;
    }
    armed.set(null);
    if (draft()?.id === item.id) draft.set(null);
    library.save((library.items() ?? []).filter((other) => other.id !== item.id));
  };
  return (
    <SettingsSection
      title={section.title()}
      note={
        section.kind === 'link'
          ? tr('Put {query} in a URL to fill it with the text typed after the name.')
          : undefined
      }
      trailing={
        <SettingsButton
          icon="plus"
          iconOnly
          tone="quiet"
          label={tr('Add to {section}', { section: section.title() })}
          disabled={library.items() === null}
          onPress={() => draft.set({ id: null, kind: section.kind, name: '', value: '' })}
        />
      }
    >
      <If when={items().length === 0 && !editing()}>
        <SettingsRow label={tr('Nothing here yet')} tone="muted" />
      </If>
      <Each of={items()} key={(item: LibraryItem) => item.id}>
        {(item) => (
          <SettingsRow
            label={item().name}
            description={item().value.replace(/\s+/g, ' ').slice(0, 120)}
            trailing={
              <>
                <SettingsButton
                  icon="edit"
                  iconOnly
                  tone="quiet"
                  label={tr('Edit')}
                  onPress={() => draft.set({ ...item() })}
                />
                <SettingsButton
                  icon={armed() === item().id ? undefined : 'trash'}
                  iconOnly={armed() !== item().id}
                  tone={armed() === item().id ? 'danger' : 'quiet'}
                  label={armed() === item().id ? tr('Confirm delete') : tr('Delete')}
                  onPress={() => remove(item())}
                />
              </>
            }
          />
        )}
      </Each>
      <If when={editing()}>
        <SettingsField
          label={tr('Name')}
          autoFocus
          value={draft()!.name}
          change={(name) => edit({ name })}
        />
        <SettingsField
          label={section.value()}
          multiline={section.kind !== 'link'}
          placeholder={section.kind === 'link' ? 'https://' : undefined}
          value={draft()!.value}
          change={(value) => edit({ value })}
        />
      </If>
    </SettingsSection>
  );
}

export function LibrarySettings(props: { library: Library }) {
  const { library } = props;
  const draft = signal<LibraryDraft | null>(null);
  const problem = computed(() => {
    const current = draft();
    return current === null ? null : draftProblem(current);
  });
  const save = () => {
    const current = draft()!;
    const item: LibraryItem = {
      id: current.id ?? crypto.randomUUID(),
      kind: current.kind,
      name: current.name.trim(),
      value: current.kind === 'link' ? current.value.trim() : current.value,
    };
    const existing = library.items() ?? [];
    library.save(
      current.id === null
        ? [...existing, item]
        : existing.map((other) => (other.id === current.id ? item : other)),
    );
    draft.set(null);
  };
  return (
    <SettingsBody
      footerShown={draft() !== null || library.failure() !== null}
      footer={
        <>
          <If when={library.failure() !== null || problem() !== null}>
            <Text
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                lineHeight: 18,
                color: C.warning,
                userSelect: 'text',
              }}
            >
              {library.failure() !== null
                ? renderText(errorText(library.failure(), 'Could not load or save shortcuts.'))
                : tr(problem()!)}
            </Text>
          </If>
          <If when={draft() !== null}>
            <SettingsButton label={tr('Cancel')} tone="quiet" onPress={() => draft.set(null)} />
            <SettingsButton
              label={tr('Save')}
              tone="primary"
              disabled={problem() !== null}
              onPress={save}
            />
          </If>
        </>
      }
    >
      <Each of={sections} key={(section: (typeof sections)[number]) => section.kind}>
        {(section) => <Section section={section()} library={library} draft={draft} />}
      </Each>
    </SettingsBody>
  );
}
