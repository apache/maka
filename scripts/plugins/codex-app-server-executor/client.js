/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with this
 * work for additional information regarding copyright ownership.
 */
window.__MakaModuleLoader__.load({
  id: 'codex-app-server-executor',
  factory(require) {
    const React = require('react');
    const { Selector } = require('@maka/ui/client-plugin');
    const EXECUTOR_ID = 'codex.app-server';
    const NATIVE_PREFIX = 'native:';
    const CODEX_PREFIX = 'codex:';

    const nativeValue = (choice) =>
      `${NATIVE_PREFIX}${encodeURIComponent(choice.connectionId)}:${encodeURIComponent(choice.connectionSlug)}:${encodeURIComponent(choice.model)}`;

    function CodexControls(owner) {
      const [models, setModels] = React.useState([]);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const selectedModel =
        owner.executorTarget?.executorId === EXECUTOR_ID ? (owner.executorTarget.model ?? '') : '';
      const selected = models.find((model) => model.model === selectedModel);
      const efforts = selected?.supportedReasoningEfforts ?? [];
      const selectedEffort = owner.executorTarget?.thinkingLevel ?? '';
      const nativeChoices = owner.modelChoices ?? [];
      const currentNative = owner.hasSession
        ? nativeChoices.find(
            (choice) =>
              choice.connectionId === owner.activeModelConnectionId &&
              choice.connectionSlug === owner.activeModelConnectionSlug &&
              choice.model === owner.activeModel,
          )
        : nativeChoices.find(
            (choice) =>
              choice.connectionId === owner.newChatModel?.llmConnectionId &&
              choice.connectionSlug === owner.newChatModel?.llmConnectionSlug &&
              choice.model === owner.newChatModel?.model,
          );

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
      const choices = [
        ...nativeChoices.map((choice) => ({
          value: nativeValue(choice),
          label: choice.label,
          description: choice.providerLabel,
        })),
        ...models.map((model) => ({
          value: `${CODEX_PREFIX}${model.model}`,
          label: model.displayName || model.model,
          description: 'Codex',
        })),
      ];
      const currentValue = selectedModel
        ? `${CODEX_PREFIX}${selectedModel}`
        : currentNative
          ? nativeValue(currentNative)
          : '';
      const currentLabel = selectedModel
        ? selected?.displayName || selectedModel
        : currentNative?.label || owner.activeModelLabel || owner.activeModel || 'Choose model';

      const onModelChange = async (value) => {
        if (value.startsWith(CODEX_PREFIX)) {
          const modelId = value.slice(CODEX_PREFIX.length);
          const model = models.find((candidate) => candidate.model === modelId);
          choose(modelId, model?.defaultReasoningEffort);
          return;
        }
        const native = nativeChoices.find((choice) => nativeValue(choice) === value);
        if (!native || !owner.onNativeModelChange) return;
        await owner.onNativeModelChange({
          llmConnectionId: native.connectionId,
          llmConnectionSlug: native.connectionSlug,
          model: native.model,
        });
      };
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(Selector, {
          label: `Model: ${currentLabel}`,
          isLabelHidden: true,
          options: choices,
          value: currentValue,
          hasSearch: true,
          variant: 'ghost',
          size: 'sm',
          placement: 'above',
          presentation: owner.presentation,
          isReadOnly: owner.isReadOnly,
          isDisabled: owner.disabled || owner.streaming || choices.length === 0,
          disabledMessage: error || undefined,
          placeholder: loading ? 'Loading models…' : error ? 'Codex unavailable' : currentLabel,
          onChange: onModelChange,
        }),
        selectedModel && efforts.length > 0
          ? React.createElement(Selector, {
              label: `Reasoning: ${selectedEffort || 'Default'}`,
              isLabelHidden: true,
              options: [
                { value: '__default__', label: 'Default' },
                ...efforts.map((effort) => ({
                  value: effort.reasoningEffort,
                  label: effort.reasoningEffort,
                })),
              ],
              value: selectedEffort || '__default__',
              variant: 'ghost',
              size: 'sm',
              placement: 'above',
              presentation: owner.presentation === 'wheel' ? 'bottom-sheet' : owner.presentation,
              isReadOnly: owner.isReadOnly,
              isDisabled: owner.disabled || owner.streaming,
              onChange: (value) =>
                choose(selectedModel, value === '__default__' ? undefined : value),
            })
          : null,
      );
    }

    let ctx;
    return {
      apply(context) {
        ctx = context;
        return ctx.slots.register(
          {
            name: 'conversation.composer.model-selection',
            select: (owner) => (owner.onExecutorTargetChange ? true : null),
            priority: 20,
          },
          (owner) => React.createElement(CodexControls, owner),
        );
      },
    };
  },
});
