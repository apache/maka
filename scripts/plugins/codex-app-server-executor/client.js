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
    const { ModelWheelPicker, Selector, SelectorOption } = require('@maka/ui/client-plugin');
    const EXECUTOR_ID = 'codex.app-server';
    const NATIVE_PREFIX = 'native:';
    const CODEX_PREFIX = 'codex:';

    const nativeValue = (choice) =>
      `${NATIVE_PREFIX}${encodeURIComponent(choice.connectionId)}:${encodeURIComponent(choice.connectionSlug)}:${encodeURIComponent(choice.model)}`;

    const providerMark = (owner, providerType) => {
      if (!providerType || !owner.renderProviderMark) return undefined;
      return React.createElement(
        'span',
        {
          className: 'modelPickerProviderMark',
          'data-provider': providerType,
          'aria-hidden': true,
        },
        owner.renderProviderMark(providerType),
      );
    };

    const codexMark = () =>
      React.createElement(
        'span',
        { className: 'modelPickerProviderMark codexModelMark', 'aria-hidden': true },
        '>_',
      );

    const optionLabel = (text) =>
      React.createElement(
        'span',
        { className: 'modelPickerOptionLabel' },
        React.createElement('bdi', null, text),
      );

    const renderOption = (option) =>
      React.createElement(SelectorOption, {
        className: 'modelPickerOption',
        icon: option.icon,
        label: optionLabel(option.label || option.value),
        description: option.description,
      });

    const renderValue = (option) =>
      React.createElement(SelectorOption, {
        icon: option.icon,
        label: optionLabel(option.label || option.value),
      });

    const nativeSections = (owner, nativeChoices) => {
      const groups = new Map();
      for (const choice of nativeChoices) {
        const group = groups.get(choice.connectionSlug);
        if (group) group.push(choice);
        else groups.set(choice.connectionSlug, [choice]);
      }
      return [...groups.values()].map((group) => ({
        type: 'section',
        title: group[0].connectionName || group[0].providerLabel,
        options: group.map((choice) => ({
          value: nativeValue(choice),
          label: choice.label,
          icon: providerMark(owner, choice.providerType),
          description:
            [choice.description, choice.knowledgeCutoff].filter(Boolean).join(' · ') || undefined,
        })),
      }));
    };

    function CodexControls(owner) {
      const [models, setModels] = React.useState([]);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);
      const modelLoad = React.useRef({ started: false, controller: null });
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

      const loadModels = React.useCallback(() => {
        if (modelLoad.current.started) return;
        const controller = new AbortController();
        modelLoad.current = { started: true, controller };
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
      }, []);
      React.useEffect(() => {
        // A selected Codex model needs its display metadata immediately. When
        // Maka has no native choices, loading is also required to avoid a
        // disabled empty picker that the user cannot open to trigger loading.
        if (selectedModel || nativeChoices.length === 0) loadModels();
      }, [selectedModel, nativeChoices.length, loadModels]);
      React.useEffect(() => () => modelLoad.current.controller?.abort(), []);

      const choose = (model, thinkingLevel) => {
        if (!owner.onExecutorTargetChange || !model) return;
        void owner.onExecutorTargetChange({
          executorId: EXECUTOR_ID,
          model,
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
      };
      const codexOptions = models.map((model) => ({
        value: `${CODEX_PREFIX}${model.model}`,
        label: model.displayName || model.model,
        icon: codexMark(),
        description: model.description,
      }));
      const choices = [
        ...nativeSections(owner, nativeChoices),
        ...(codexOptions.length > 0
          ? [{ type: 'section', title: 'Codex', options: codexOptions }]
          : []),
      ];
      const currentValue = selectedModel
        ? `${CODEX_PREFIX}${selectedModel}`
        : currentNative
          ? nativeValue(currentNative)
          : '';
      const currentLabel = selectedModel
        ? selected?.displayName || selectedModel
        : currentNative?.label || owner.activeModelLabel || owner.activeModel || 'Choose model';
      const controlLabel = owner.purpose === 'new-work-default' ? 'New work model' : 'Model';

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
      const wheelOptions = [
        ...nativeChoices.map((choice) => ({
          value: nativeValue(choice),
          label: choice.label,
          heading: choice.connectionName || choice.providerLabel,
          description: choice.description,
        })),
        ...codexOptions.map((option) => ({
          value: option.value,
          label: option.label,
          heading: 'Codex',
          description: option.description,
        })),
      ];
      const [wheelOpen, setWheelOpen] = React.useState(false);
      React.useEffect(() => setWheelOpen(false), [owner.sessionId]);
      const modelPickerControl =
        owner.presentation === 'wheel'
          ? React.createElement(ModelWheelPicker, {
              options: wheelOptions,
              value: currentValue,
              label: currentLabel,
              ariaLabel: `${controlLabel}: ${currentLabel}`,
              icon: selectedModel ? codexMark() : providerMark(owner, currentNative?.providerType),
              tooltip: controlLabel,
              triggerClassName: 'maka-model-switcher-trigger',
              disabled: owner.disabled || owner.streaming || wheelOptions.length === 0,
              open: wheelOpen,
              onOpenChange: (open) => {
                if (open) loadModels();
                setWheelOpen(open);
              },
              onValueChange: onModelChange,
            })
          : React.createElement(Selector, {
              label: `${controlLabel}: ${currentLabel}`,
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
              className: owner.hasSession
                ? 'maka-model-switcher-trigger'
                : 'maka-new-chat-model-selector',
              onChange: onModelChange,
              renderOption,
              renderValue,
            });
      const modelPicker =
        owner.presentation === 'wheel'
          ? modelPickerControl
          : React.createElement(
              'span',
              {
                style: { display: 'contents' },
                onPointerDownCapture: loadModels,
                onKeyDownCapture: (event) => {
                  if (
                    event.key === 'Enter' ||
                    event.key === ' ' ||
                    event.key === 'ArrowDown' ||
                    event.key === 'ArrowUp'
                  )
                    loadModels();
                },
              },
              modelPickerControl,
            );
      return React.createElement(
        React.Fragment,
        null,
        modelPicker,
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
              className: 'maka-thinking-level-selector',
              onChange: (value) =>
                choose(selectedModel, value === '__default__' ? undefined : value),
            })
          : selectedModel
            ? null
            : (owner.renderNativeThinkingControl?.() ?? null),
      );
    }

    let ctx;
    return {
      apply(context) {
        ctx = context;
        ctx.style(
          `.codexModelMark { display: inline-grid; place-items: center; font: 600 9px/1 ui-monospace, monospace; letter-spacing: -1px; }`,
          'Codex model mark',
        );
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
