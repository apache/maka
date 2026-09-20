/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with this
 * work for additional information regarding copyright ownership.
 */
window.__MakaModuleLoader__.load({
  id: 'codex-app-server-executor',
  factory(require) {
    const React = require('react');
    const EXECUTOR_ID = 'codex.app-server';

    function CodexControls(owner) {
      const [models, setModels] = React.useState([]);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const selectedModel =
        owner.executorTarget?.executorId === EXECUTOR_ID ? (owner.executorTarget.model ?? '') : '';
      const selected = models.find((model) => model.model === selectedModel);
      const efforts = selected?.supportedReasoningEfforts ?? [];
      const selectedEffort = owner.executorTarget?.thinkingLevel ?? '';

      React.useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        ctx.remote
          .call('codex.app-server.models', {}, { signal: controller.signal })
          .then((value) => {
            if (!Array.isArray(value)) throw new Error('Codex returned an invalid model list');
            setModels(value);
            setError('');
          })
          .catch((reason) => {
            if (!controller.signal.aborted)
              setError(reason instanceof Error ? reason.message : String(reason));
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
        return () => controller.abort();
      }, []);

      const choose = (model, thinkingLevel) => {
        if (!owner.onExecutorTargetChange || !model) return;
        void owner.onExecutorTargetChange({
          executorId: EXECUTOR_ID,
          model,
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
      };
      return React.createElement(
        'span',
        { className: 'codexExecutorControls' },
        React.createElement(
          'label',
          { className: 'codexExecutorField' },
          React.createElement('span', { className: 'codexExecutorLabel' }, 'Codex'),
          React.createElement(
            'select',
            {
              'aria-label': 'Codex model',
              disabled: owner.disabled || owner.streaming || loading || Boolean(error),
              value: selectedModel,
              title: error || 'Codex model',
              onChange: (event) => {
                const model = models.find((item) => item.model === event.target.value);
                choose(event.target.value, model?.defaultReasoningEffort);
              },
            },
            React.createElement(
              'option',
              { value: '', disabled: true },
              loading ? 'Loading Codex…' : error ? 'Codex unavailable' : 'Choose Codex',
            ),
            models.map((model) =>
              React.createElement(
                'option',
                {
                  key: model.model,
                  value: model.model,
                },
                model.displayName || model.model,
              ),
            ),
          ),
        ),
        selectedModel && efforts.length > 0
          ? React.createElement(
              'label',
              { className: 'codexExecutorField' },
              React.createElement('span', { className: 'codexExecutorLabel' }, 'Reasoning'),
              React.createElement(
                'select',
                {
                  'aria-label': 'Codex reasoning effort',
                  disabled: owner.disabled || owner.streaming,
                  value: selectedEffort,
                  onChange: (event) => choose(selectedModel, event.target.value || undefined),
                },
                React.createElement('option', { value: '' }, 'Default'),
                efforts.map((effort) =>
                  React.createElement(
                    'option',
                    {
                      key: effort.reasoningEffort,
                      value: effort.reasoningEffort,
                    },
                    effort.reasoningEffort,
                  ),
                ),
              ),
            )
          : null,
      );
    }

    let ctx;
    return {
      apply(context) {
        ctx = context;
        ctx.style(
          `
          .codexExecutorControls { display: inline-flex; align-items: center; gap: 6px; }
          .codexExecutorField { display: inline-flex; align-items: center; gap: 4px; }
          .codexExecutorLabel { font-size: 11px; opacity: .72; }
          .codexExecutorField select { max-width: 170px; height: 28px; border-radius: 7px;
            border: 1px solid var(--astryx-border-subtle, rgba(127,127,127,.28));
            background: var(--astryx-background-surface, transparent); color: inherit; padding: 0 7px; }
        `,
          'Codex executor controls',
        );
        return ctx.slots.register(
          { name: 'conversation.composer.toolbar', id: 'codex-controls', priority: 20 },
          (owner) => React.createElement(CodexControls, owner),
        );
      },
    };
  },
});
