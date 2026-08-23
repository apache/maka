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

import type { ReactNode } from 'react';
import { SettingsRow } from './settings-section.js';

/**
 * `value` is optional: a row may exist for what it explains and what it lets
 * you do, with nothing to read out. 输入历史 is one — naming its storage
 * mechanism told the user nothing they could act on, and the action beside it
 * is the whole point of the row.
 */
export function SettingRow(props: { title: string; detail: string; value?: string; mono?: boolean; action?: ReactNode }) {
  // `mono` means the value is machine text — a path, an id, a key. That is a
  // markup fact, and since the role table composes the code family for the
  // code element group, saying it in the markup is also what makes it render
  // monospaced. The layout rule (break-all, start) selects the same element,
  // so there is no second name for it: `code.settingsReadOnlyValue`.
  //
  // Layout differs by kind: a short human value rides the row's end slot,
  // but machine text (an absolute workspace path) squeezed into a
  // right-anchored 320px box wrapped into a ragged four-line block — the
  // audit's least readable row. Mono values render as a full-width line
  // under the description instead, where break-all reads as intended.
  if (props.mono) {
    return (
      <SettingsRow
        label={props.title}
        align="start"
        description={(
          <>
            {props.detail ? <span>{props.detail}</span> : null}
            <code className="settingsReadOnlyValue" data-mono="true">{props.value}</code>
          </>
        )}
        end={props.action ?? undefined}
      />
    );
  }
  const value = props.value ? <span className="settingsReadOnlyValue">{props.value}</span> : null;
  const end = props.action ? <>{value}{props.action}</> : value;
  return (
    <SettingsRow
      label={props.title}
      description={props.detail || undefined}
      align="start"
      end={end ?? undefined}
    />
  );
}
