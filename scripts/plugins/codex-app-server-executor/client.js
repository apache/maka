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
  id: 'codex-app-server-executor',
  factory(require) {
    const React = require('react');
    const EXECUTOR_ID = 'codex.app-server';

    function CodexModels(owner) {
      const [models, setModels] = React.useState([]);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);
      const modelLoad = React.useRef({ started: false, controller: null });
      const loadModels = React.useCallback(() => {
        if (modelLoad.current.started) return;
        const controller = new AbortController();
        modelLoad.current = { started: true, controller };
        setLoading(true);
        setError('');
        ctx.remote
          .call('codex.app-server.models', {}, { signal: controller.signal })
          .then((value) => {
            if (!Array.isArray(value)) throw new Error('Codex returned an invalid model list');
            if (!controller.signal.aborted) setModels(value);
          })
          .catch((reason) => {
            if (!controller.signal.aborted) {
              modelLoad.current.started = false;
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      }, []);
      const selected = owner.executorTarget?.executorId === EXECUTOR_ID;
      React.useEffect(() => {
        if (selected || !owner.hasModels) loadModels();
      }, [selected, owner.hasModels, loadModels]);
      React.useEffect(() => () => modelLoad.current.controller?.abort(), []);
      return owner.renderPicker({
        id: EXECUTOR_ID,
        label: 'Codex',
        models: models.map((model) => ({
          id: model.model,
          label: model.displayName || model.model,
          providerType: 'openai',
          thinkingLevels: (model.supportedReasoningEfforts ?? []).map(
            (effort) => effort.reasoningEffort,
          ),
          defaultThinkingLevel: model.defaultReasoningEffort,
        })),
        loading,
        error,
        onLoad: loadModels,
      });
    }

    let ctx;
    return {
      apply(context) {
        ctx = context;
        return ctx.slots.register(
          {
            name: 'conversation.composer.model-selection',
            select: (owner) =>
              owner.renderPicker &&
              (!owner.fixedExecutorId || owner.fixedExecutorId === EXECUTOR_ID)
                ? true
                : null,
            priority: 20,
          },
          (owner) => React.createElement(CodexModels, owner),
        );
      },
    };
  },
});
