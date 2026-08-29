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

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatRecoveryNotice } from '../../renderer/chat-recovery-notice.js';
import { SessionHealthRecoveryNotice } from '../../renderer/chat-recovery-notice.js';

test('composer recovery notices share one wrapper and secondary disabled action', () => {
  const markup = renderToStaticMarkup(createElement(ChatRecoveryNotice, {
    status: 'error',
    title: 'Choose a model connection',
    description: 'Choose the connection and model to use.',
    actionLabel: 'Choose connection and model',
    actionDisabled: true,
    onAction: () => undefined,
  }));

  assert.match(markup, /class="maka-chat-recovery-notice"/);
  assert.match(markup, /maka-chat-recovery-notice-alert/);
  assert.match(markup, /Choose a model connection/);
  assert.match(markup, /Choose the connection and model to use\./);
  assert.match(markup, /Choose connection and model/);
  assert.match(markup, /disabled=""/);
  assert.match(markup, /secondary/);
});

test('composer recovery notices omit the action when no handler exists', () => {
  const markup = renderToStaticMarkup(createElement(ChatRecoveryNotice, {
    status: 'warning',
    title: 'Workspace unavailable',
    actionLabel: 'Open Settings',
  }));

  assert.doesNotMatch(markup, /<button/);
});

test('Session recovery disables only a hidden model-picker action', () => {
  const markup = renderToStaticMarkup(createElement(SessionHealthRecoveryNotice, {
    notice: {
      tone: 'destructive',
      label: 'Choose a model connection',
      actionLabel: 'Choose connection and model',
      actionDisabled: false,
      onClickTarget: 'model_picker',
      onClick: () => undefined,
    },
    fallbackActionLabel: 'Open model settings',
    modelPickerAvailable: false,
  }));

  assert.match(markup, /disabled=""/);
});

test('a hidden model picker does not disable reload or Settings recovery', () => {
  for (const onClickTarget of ['model_choices_refresh', 'models'] as const) {
    const markup = renderToStaticMarkup(createElement(SessionHealthRecoveryNotice, {
      notice: {
        tone: 'destructive',
        label: 'Connection unavailable',
        actionLabel: 'Recover',
        onClickTarget,
        onClick: () => undefined,
      },
      fallbackActionLabel: 'Open model settings',
      modelPickerAvailable: false,
    }));
    assert.doesNotMatch(markup, /disabled=""/);
  }
});
