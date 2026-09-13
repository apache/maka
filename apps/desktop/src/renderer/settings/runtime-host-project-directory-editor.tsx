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

import { Button, TextInput } from '@maka/ui';
import { PROJECT_DIRECTORY_MAX_ROOTS } from '@maka/runtime-host/protocol';
import type { SettingsProjectsCopy } from '../locales/settings-projects-copy.js';

export interface ProjectDirectoryRootDraft {
  readonly id: number;
  readonly label: string;
  readonly path: string;
}

export function RuntimeHostProjectDirectoryEditor(props: {
  readonly roots: readonly ProjectDirectoryRootDraft[];
  readonly isDisabled: boolean;
  readonly nextId: () => number;
  readonly copy: SettingsProjectsCopy['runtimeHost'];
  readonly onChange: (roots: readonly ProjectDirectoryRootDraft[]) => void;
}) {
  return (
    <>
      <div className="settingsRuntimeHostManagementRootEditor">
        {props.roots.map((root) => (
          <div className="settingsRuntimeHostManagementRootRow" key={root.id}>
            <TextInput
              label={props.copy.directoryRootLabel}
              value={root.label}
              isDisabled={props.isDisabled}
              onChange={(label) => props.onChange(props.roots.map((candidate) =>
                candidate.id === root.id ? { ...candidate, label } : candidate))}
            />
            <TextInput
              label={props.copy.directoryRootPath}
              value={root.path}
              isDisabled={props.isDisabled}
              onChange={(path) => props.onChange(props.roots.map((candidate) =>
                candidate.id === root.id ? { ...candidate, path } : candidate))}
            />
            <Button
              variant="secondary"
              size="sm"
              label={props.copy.removeDirectoryRoot}
              isDisabled={props.isDisabled}
              onClick={() => props.onChange(
                props.roots.filter((candidate) => candidate.id !== root.id),
              )}
            />
          </div>
        ))}
      </div>
      <Button
        variant="secondary"
        size="sm"
        label={props.copy.addDirectoryRoot}
        isDisabled={props.isDisabled || props.roots.length >= PROJECT_DIRECTORY_MAX_ROOTS}
        onClick={() => props.onChange([
          ...props.roots,
          { id: props.nextId(), label: '', path: '' },
        ])}
      />
    </>
  );
}
