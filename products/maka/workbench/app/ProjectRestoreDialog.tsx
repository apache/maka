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

import { cleanup, signal, Text } from 'nsh';
import type {
  AgentProject,
  AgentProjectLocation,
} from '../../../../packages/plugin-sdk/src/index.js';
import { useHost } from './host';
import { tr } from './locale';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { restoreArchivedProject } from './projectRegistration';
import { SettingsButton } from './SettingsPage';
import { errorText, renderText, type UiText } from './text';
import { C } from './ui';

export function ProjectRestoreDialog(props: {
  project: AgentProject;
  location: AgentProjectLocation;
  close(): void;
  restored(project: AgentProject): Promise<void> | void;
}) {
  const host = useHost();
  const restoring = signal(false);
  const error = signal<UiText>('');
  let alive = true;
  cleanup(() => {
    alive = false;
  });

  const cancel = () => {
    if (!restoring()) props.close();
  };

  const confirm = async () => {
    if (!alive || restoring()) return;
    restoring.set(true);
    error.set('');
    try {
      const project = await restoreArchivedProject(host, props.project, props.location.path);
      if (!alive) return;
      await props.restored(project);
      if (alive) props.close();
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not restore the project.'));
    } finally {
      if (alive) restoring.set(false);
    }
  };

  return (
    <ModalDialog size="alert" onCancel={cancel}>
      <DialogHeader
        title={tr('Restore “{name}”?', { name: props.project.name })}
        detail={tr(
          'This folder belongs to an archived project. Restore it to show it in the sidebar again.',
        )}
      />
      <If when={renderText(error())}>
        <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>{renderText(error())}</Text>
      </If>
      <If when={restoring()}>
        <Text style={{ color: C.muted }}>{tr('Restoring project…')}</Text>
      </If>
      <DialogFooter>
        <SettingsButton
          label={tr('Cancel')}
          tone="quiet"
          autoFocus
          disabled={restoring()}
          onPress={cancel}
        />
        <SettingsButton
          label={tr('Restore')}
          tone="primary"
          disabled={restoring()}
          onPress={() => void confirm()}
        />
      </DialogFooter>
    </ModalDialog>
  );
}
