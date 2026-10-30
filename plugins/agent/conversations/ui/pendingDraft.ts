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

import { cleanup, effect, signal, untracked } from 'nsh';
import type { StagedFile } from 'maka/host';
import type { AgentWorkspaceAccess } from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import type { BrowserWorkspace } from '../../../../products/maka/workbench/app/browsing';
import type { Host } from '../../../../products/maka/workbench/app/host';
import type { ModelBackend } from '../../../../products/maka/workbench/app/modelSelection';
import { UiError } from '../../../../products/maka/workbench/app/text';

type Phase =
  | { kind: 'local' }
  | { kind: 'creating'; operationId: string }
  | { kind: 'session'; sessionId: string };

type Draft = {
  workspace: BrowserWorkspace;
  workspaceLabel: string;
  text: string;
  backend: ModelBackend | null;
  access: AgentWorkspaceAccess | null;
  requests: boolean | null;
  modelChosen: boolean;
  phase: Phase;
  files: string[];
};

type File = { id: string; name: string; bytes: number; file: StagedFile };

export function createPendingDraft(
  host: Host,
  report: (reason: unknown) => void,
  enabled: boolean,
) {
  const state = signal<Draft | null>(null);
  const ready = signal(false);
  const failure = signal<{ reason: unknown } | null>(null);
  const version = signal(0);
  const files = signal(new Map<string, File>());
  const retired: StagedFile[] = [];
  let alive = true;
  let revision = 0;
  let saved = 'null';
  let next: { state: Draft | null; files: StagedFile[] } | null = null;
  let writing: Promise<void> | null = null;

  const remember = (selected: StagedFile[]) => {
    const restored = new Map(files());
    for (const file of selected) {
      const metadata = file.metadata() as { name: string; bytes: number };
      restored.set(file.id, { id: file.id, ...metadata, file });
    }
    files.set(restored);
  };
  const replace = (draft: Draft | null) => {
    state.set(draft);
    version.set(version() + 1);
  };
  const update = (patch: Partial<Draft>) => {
    const draft = state();
    if (draft) replace({ ...draft, ...patch });
  };
  const save = () => {
    if (!enabled || !alive || !ready() || failure()) return;
    next = { state: state(), files: [...files().values()].map((item) => item.file) };
    if (writing) return;
    writing = (async () => {
      while (next && alive) {
        const current = next;
        next = null;
        const encoded = JSON.stringify(current.state);
        if (encoded === saved) continue;
        revision = await host.savePendingDraft(
          revision,
          current.state,
          current.state?.files ?? [],
          current.files,
        );
        saved = encoded;
      }
      for (const file of retired.splice(0)) file.dispose();
    })()
      .catch((reason) => {
        failure.set({ reason });
        report(reason);
      })
      .finally(() => {
        writing = null;
        if (next && !failure()) save();
      });
  };
  const flush = async () => {
    if (!ready()) throw failure()?.reason ?? new UiError('The saved draft could not be loaded.');
    if (writing) await writing;
    failure.set(null);
    save();
    while (writing) await writing;
    const rejected = failure();
    if (rejected) throw rejected.reason;
  };
  const restoreFiles = async () => {
    const ids = state()?.files ?? [];
    if (!ids.length) return;
    const restored = await host.restorePendingFiles(ids.filter((id) => !files().has(id)));
    if (!alive || state()?.files !== ids) {
      for (const file of restored) file.dispose();
      return;
    }
    remember(restored);
  };
  const loaded = (async () => {
    if (!enabled) {
      ready.set(true);
      return;
    }
    const stored = await host.loadPendingDraft();
    if (!alive) return;
    revision = stored.revision;
    saved = JSON.stringify(stored.state);
    state.set(stored.state as Draft | null);
    if (state()?.phase.kind !== 'session') await restoreFiles();
    if (alive) ready.set(true);
  })().catch((reason) => {
    failure.set({ reason });
    report(reason);
  });
  effect(() => {
    state();
    if (ready()) untracked(save);
  });
  cleanup(() => {
    alive = false;
    for (const item of files().values()) item.file.dispose();
    files.set(new Map());
    for (const file of retired.splice(0)) file.dispose();
  });

  return {
    state,
    ready,
    version,
    loaded,
    update,
    flush,
    restoreFiles,
    start(workspace: BrowserWorkspace, workspaceLabel: string) {
      for (const item of files().values()) retired.push(item.file);
      files.set(new Map());
      replace({
        workspace,
        workspaceLabel,
        text: '',
        backend: null,
        access: null,
        requests: null,
        modelChosen: false,
        phase: { kind: 'local' },
        files: [],
      });
    },
    files: () => [...files().values()],
    addFiles(selected: StagedFile[]) {
      remember(selected);
      update({ files: [...state()!.files, ...selected.map((file) => file.id)] });
    },
    removeFile(id: string) {
      const selected = files().get(id);
      if (!selected) return;
      retired.push(selected.file);
      const remaining = new Map(files());
      remaining.delete(id);
      files.set(remaining);
      update({ files: state()!.files.filter((file) => file !== id) });
    },
    takeFiles() {
      const selected = [...files().values()].map((item) => item.file);
      files.set(new Map());
      return selected;
    },
    clear() {
      for (const item of files().values()) retired.push(item.file);
      files.set(new Map());
      replace(null);
    },
  };
}
