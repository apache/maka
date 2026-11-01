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

import { AttachmentPicker } from 'maka/host';
import type { JSX } from 'nsh';
import type { ComposerAttachments } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { AttachmentDraft } from './attachmentDraft';
import type { Host } from './host';
import { immutableAsset } from './immutableAsset';
import { renderText } from './text';

/** Keep the native upload owner and receipt lifecycle inside the session. */
export function projectComposerAttachments(
  draft: AttachmentDraft,
  host: Host,
): ComposerAttachments<JSX.Element> {
  return {
    sessionId: draft.sessionId,
    files: draft.files,
    rows: () =>
      draft.rows().map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        ...(row.error === undefined ? {} : { error: renderText(row.error) }),
      })),
    ids: draft.ids,
    picker: draft.picker,
    restoring: draft.restoring,
    error: draft.error,
    notice: draft.notice,
    recovering: draft.recovering,
    imageUri: (read) => host.assetUri(immutableAsset('attachment-image', read)),
    renderPicker: (input) => (
      <AttachmentPicker client={draft.client} {...input} onStatus={draft.status} />
    ),
    pasteClipboard: (onText) => draft.observeIntake(draft.client.beginClipboardPaste(), onText),
    dropFiles: (uris, onText) => draft.observeIntake(draft.client.beginFileDrop(uris), onText),
    open: draft.open,
    remove: draft.remove,
    reportError: draft.reportError,
    notify: draft.notify,
    clearNotice: draft.clearNotice,
  };
}
