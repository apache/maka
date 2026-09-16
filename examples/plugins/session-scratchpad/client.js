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

window.__MakaModuleLoader__.load({
  id: 'maka.session-scratchpad',
  factory(require) {
    const React = require('react');
    const {
      Badge,
      Button,
      Card,
      HStack,
      Spinner,
      Text,
      TextArea,
      VStack,
    } = require('@maka/ui/client-plugin');
    const listeners = new Set();
    let view = Object.freeze({ open: false, sessionId: undefined, sessionName: '' });

    const updateView = (next) => {
      view = Object.freeze({ ...view, ...next });
      for (const listener of listeners) listener();
    };
    const subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const snapshot = () => view;

    return {
      apply(ctx, config) {
        const maxLength = Number.isSafeInteger(config.maxLength) ? config.maxLength : 12000;

        ctx.style(
          `.maka-session-scratchpad-backdrop{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end;padding:16px}.maka-session-scratchpad-panel{width:min(460px,calc(100vw - 32px));height:100%;overflow:auto}.maka-session-scratchpad-textarea{width:100%;min-height:260px}`,
          'Session Scratchpad surface',
        );

        ctx.slots.register(
          { name: 'conversation.header.actions', id: 'session-scratchpad', order: 40 },
          ({ sessionId, sessionName }) =>
            React.createElement(Button, {
              size: 'sm',
              variant: 'ghost',
              label: 'Scratchpad',
              onClick: () => updateView({ open: true, sessionId, sessionName }),
            }),
        );

        ctx.slots.register({ name: 'shell.overlay', id: 'session-scratchpad', order: 40 }, () =>
          React.createElement(ScratchpadOverlay, { ctx, maxLength }),
        );
      },
    };

    function ScratchpadOverlay({ ctx, maxLength }) {
      const current = React.useSyncExternalStore(subscribe, snapshot, snapshot);
      const [state, setState] = React.useState({
        status: 'idle',
        text: '',
        revision: 0,
        updatedAt: null,
        error: '',
        toolActivity: 0,
      });

      React.useEffect(() => {
        if (!current.open || !current.sessionId) return undefined;
        let active = true;
        let iterator;
        setState({
          status: 'loading',
          text: '',
          revision: 0,
          updatedAt: null,
          error: '',
          toolActivity: 0,
        });
        const stopEvents = ctx.events.on('tool.activity', { sessionId: current.sessionId }, () =>
          setState((value) => ({ ...value, toolActivity: value.toolActivity + 1 })),
        );
        const run = async () => {
          try {
            const stream = ctx.remote.stream(
              'session-scratchpad.watch',
              {},
              { sessionId: current.sessionId },
            );
            iterator = stream[Symbol.asyncIterator]();
            while (active) {
              const next = await iterator.next();
              if (next.done || !active) break;
              setState((value) => ({
                ...value,
                status: 'ready',
                text: next.value.text,
                revision: next.value.revision,
                updatedAt: next.value.updatedAt,
                error: '',
              }));
            }
          } catch (error) {
            if (active) {
              setState((value) => ({
                ...value,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
              }));
            }
          }
        };
        void run();
        return () => {
          active = false;
          stopEvents();
          void iterator?.return?.();
        };
      }, [ctx, current.open, current.sessionId]);

      if (!current.open || !current.sessionId) return null;

      const save = async () => {
        setState((value) => ({ ...value, status: 'saving', error: '' }));
        try {
          const saved = await ctx.remote.call(
            'session-scratchpad.save',
            { text: state.text, expectedRevision: state.revision },
            { sessionId: current.sessionId },
          );
          setState((value) => ({
            ...value,
            status: 'ready',
            revision: saved.revision,
            updatedAt: saved.updatedAt,
          }));
        } catch (error) {
          setState((value) => ({
            ...value,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      };

      const close = () => updateView({ open: false, sessionId: undefined, sessionName: '' });
      return React.createElement(
        'div',
        { className: 'maka-session-scratchpad-backdrop', onMouseDown: close },
        React.createElement(
          Card,
          {
            className: 'maka-session-scratchpad-panel',
            padding: 5,
            onMouseDown: (event) => event.stopPropagation(),
          },
          React.createElement(
            VStack,
            { gap: 4, width: '100%' },
            React.createElement(
              HStack,
              { gap: 2, width: '100%', hAlign: 'space-between', vAlign: 'center' },
              React.createElement(
                VStack,
                { gap: 1 },
                React.createElement(Text, null, 'Session Scratchpad'),
                React.createElement(
                  Text,
                  { type: 'supporting', color: 'secondary' },
                  current.sessionName,
                ),
              ),
              React.createElement(Button, { variant: 'ghost', label: 'Close', onClick: close }),
            ),
            state.status === 'loading'
              ? React.createElement(Spinner, { label: 'Loading scratchpad' })
              : React.createElement(TextArea, {
                  className: 'maka-session-scratchpad-textarea',
                  label: 'Notes for this Session',
                  value: state.text,
                  rows: 12,
                  maxLength,
                  onChange: (text) => setState((value) => ({ ...value, text })),
                }),
            state.error ? React.createElement(Text, { color: 'danger' }, state.error) : null,
            React.createElement(
              HStack,
              { gap: 2, width: '100%', hAlign: 'space-between', vAlign: 'center' },
              React.createElement(
                HStack,
                { gap: 2, vAlign: 'center' },
                React.createElement(Badge, {
                  variant: state.status === 'error' ? 'error' : 'neutral',
                  label: state.status === 'saving' ? 'Saving' : 'Synced',
                }),
                React.createElement(
                  Text,
                  { type: 'supporting', color: 'secondary' },
                  `${state.text.length}/${maxLength}`,
                ),
                state.toolActivity > 0
                  ? React.createElement(Badge, {
                      variant: 'info',
                      label: `${state.toolActivity} live tool events`,
                    })
                  : null,
              ),
              React.createElement(Button, {
                variant: 'primary',
                label: 'Save',
                isLoading: state.status === 'saving',
                isDisabled: state.status === 'loading' || state.text.length > maxLength,
                onClick: () => void save(),
              }),
            ),
          ),
        ),
      );
    }
  },
});
