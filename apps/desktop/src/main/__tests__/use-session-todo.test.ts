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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement } from 'react';
import type { SessionTodoItem } from '@maka/core/session-todo';
import type { UiLocale } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeWorkbarServices,
  useSessionTodo,
  WorkbarServicesProvider,
  type WorkbarServices,
} from '../../renderer/features/workbar/testing.js';

/**
 * Regression coverage for the Traditional Chinese error-copy leak
 * (2026-09-02 review): this hook used to route zh-CN and zh-TW through the
 * same hard-coded Simplified helper, so a zh-TW reader saw 请求超时 instead
 * of 請求逾時. It now goes through the shared, locale-aware classifier like
 * every sibling surface (use-session-trace.ts, session-review-panel.tsx,
 * session-terminal-panel.tsx, artifact-pane.tsx).
 */

function Probe(props: {
  services: WorkbarServices;
  sessionId?: string;
  locale: UiLocale;
  onSnapshot: (snapshot: ReturnType<typeof useSessionTodo>) => void;
}) {
  return createElement(
    WorkbarServicesProvider,
    { services: props.services },
    createElement(TodoProbe, props),
  );
}

function TodoProbe(props: {
  sessionId?: string;
  locale: UiLocale;
  onSnapshot: (snapshot: ReturnType<typeof useSessionTodo>) => void;
}) {
  const snapshot = useSessionTodo(props.sessionId, {
    locale: props.locale,
    loadFailed: 'load failed',
  });
  props.onSnapshot(snapshot);
  return null;
}

function createHarness(read: () => Promise<SessionTodoItem[]>): WorkbarServices {
  return createFakeWorkbarServices({
    todo: {
      read,
      subscribeChanges: () => () => undefined,
    },
  });
}

describe('useSessionTodo', () => {
  afterEach(() => {
    cleanupFakeDom();
    delete (globalThis as { window?: unknown }).window;
  });

  it('renders the Traditional Chinese category copy for a zh-TW reader, not Simplified', async () => {
    const { root } = installReactRenderer();
    const services = createHarness(async () => {
      throw new Error('request timeout');
    });
    let snapshot: ReturnType<typeof useSessionTodo> | undefined;

    await act(async () => {
      root.render(
        createElement(Probe, {
          services,
          sessionId: 'session-1',
          locale: 'zh-TW',
          onSnapshot: (value) => {
            snapshot = value;
          },
        }),
      );
    });

    assert.equal(snapshot?.error, '請求逾時', 'a zh-TW reader must not see Simplified 请求超时');
  });

  it('still renders the Simplified Chinese category copy for a zh-CN reader', async () => {
    const { root } = installReactRenderer();
    const services = createHarness(async () => {
      throw new Error('request timeout');
    });
    let snapshot: ReturnType<typeof useSessionTodo> | undefined;

    await act(async () => {
      root.render(
        createElement(Probe, {
          services,
          sessionId: 'session-1',
          locale: 'zh-CN',
          onSnapshot: (value) => {
            snapshot = value;
          },
        }),
      );
    });

    assert.equal(snapshot?.error, '请求超时');
  });

  it('falls back to the caller-supplied copy for an unclassified error in English', async () => {
    const { root } = installReactRenderer();
    const services = createHarness(async () => {
      throw new Error('unexpected boom');
    });
    let snapshot: ReturnType<typeof useSessionTodo> | undefined;

    await act(async () => {
      root.render(
        createElement(Probe, {
          services,
          sessionId: 'session-1',
          locale: 'en',
          onSnapshot: (value) => {
            snapshot = value;
          },
        }),
      );
    });

    assert.equal(snapshot?.error, 'load failed');
  });
});
