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

import { tr } from '../../locale';
import type {
  WebSettings,
  WebSnapshot,
  WebUpdate,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { LocalizedSettingsError, type SettingsRpc } from './rpc';

function updated(result: WebUpdate) {
  switch (result.kind) {
    case 'updated':
      return result.snapshot;
    case 'changed':
      throw new LocalizedSettingsError('Refresh and try again.', { cause: result });
    case 'invalid_key':
      throw new LocalizedSettingsError('Invalid API key', { cause: result });
    case 'invalid_settings':
      throw new Error(tr('Could not read or update settings.'), { cause: result.message });
    case 'check_unavailable':
      throw new LocalizedSettingsError('Unavailable', { cause: result });
    default:
      throw new Error(tr('Could not read or update settings.'), { cause: result });
  }
}

export async function saveWebSettings(
  rpc: SettingsRpc,
  snapshot: WebSnapshot,
  settings: WebSettings,
) {
  return updated(
    await rpc.mutate('workspaceWeb', 'save', { revision: snapshot.revision, settings }),
  );
}

export async function updateWebKey(
  rpc: SettingsRpc,
  snapshot: WebSnapshot,
  action: 'saveKey' | 'deleteKey' | 'checkKey',
  secret?: string,
) {
  return updated(
    await rpc.mutate(
      'workspaceWeb',
      action,
      {
        settingsRevision: snapshot.revision,
        revision: snapshot.credential.revision,
      },
      { secret },
    ),
  );
}
