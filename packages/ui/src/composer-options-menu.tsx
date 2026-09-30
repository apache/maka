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

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSubMenu,
} from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { ProviderType } from '@maka/core/llm-connections';
import { exactModelChoiceValue, type ChatModelChoice } from './chat-model-helpers.js';
import { formatCompactTokenCount } from './compact-token-count.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { usePendingSelection } from './use-pending-selection.js';

const DEFAULT_EFFORT = '__default__';

// DropdownMenuSubMenu has no endContent slot, so the current value rides in the
// label until Astryx offers one.
function OptionRow(props: { label: string; value: string }) {
  return (
    <span className="maka-composer-options-row">
      <span>{props.label}</span>
      <span className="maka-composer-options-value">{props.value}</span>
    </span>
  );
}

/**
 * One footer menu for the native model: thinking effort and the model. The
 * trigger shows the context window read-only beside the model name.
 */
export function ComposerOptionsMenu(props: {
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  isReadOnly?: boolean;
  openNonce?: number;
  choices: readonly ChatModelChoice[];
  currentModelValue?: string;
  onModelChange?(input: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }): void | Promise<void>;
  thinkingLevels?: readonly ThinkingLevel[];
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?(level: ThinkingLevel | undefined): void | Promise<void>;
  hasConversationHistory?: boolean;
  sessionId?: string;
  renderProviderMark?(type: ProviderType): ReactNode;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).model;
  const choice = props.choices.find(
    (candidate) => exactModelChoiceValue(candidate.connectionId, candidate.connectionSlug, candidate.model) === props.currentModelValue,
  );
  const [open, setOpen] = useState(false);
  const nonceRef = useRef(props.openNonce ?? 0);
  useEffect(() => {
    const nonce = props.openNonce ?? 0;
    if (nonce === nonceRef.current) return;
    nonceRef.current = nonce;
    if (!props.disabled && !props.isReadOnly) setOpen(true);
  }, [props.openNonce, props.disabled, props.isReadOnly]);
  useEffect(() => {
    if (props.isReadOnly) setOpen(false);
  }, [props.isReadOnly]);

  const effortSelection = usePendingSelection(
    props.thinkingLevel ?? DEFAULT_EFFORT,
    (value) => props.onThinkingLevelChange?.(value === DEFAULT_EFFORT ? undefined : (value as ThinkingLevel)),
  );
  const modelSelection = usePendingSelection(props.currentModelValue ?? '', async (value) => {
    const next = props.choices.find(
      (candidate) => exactModelChoiceValue(candidate.connectionId, candidate.connectionSlug, candidate.model) === value,
    );
    if (!next) return;
    await props.onModelChange?.({
      llmConnectionId: next.connectionId,
      llmConnectionSlug: next.connectionSlug,
      model: next.model,
    });
  });

  const [acknowledgedSessions, setAcknowledgedSessions] = useState<ReadonlySet<string>>(() => new Set());
  const noticeShown = props.hasConversationHistory === true
    && props.sessionId !== undefined
    && !acknowledgedSessions.has(props.sessionId);

  const effortValue = props.thinkingLevels?.find((level) => level === effortSelection.value);
  const effortRow = effortValue ? copy.level[effortValue] : copy.defaultLevel;
  const triggerDetails = [
    choice?.contextWindow ? formatCompactTokenCount(choice.contextWindow) : undefined,
    effortValue ? copy.level[effortValue] : undefined,
  ].filter((detail): detail is string => detail !== undefined).join(' ');
  const triggerLabel = triggerDetails ? `${props.label} ${triggerDetails}` : props.label;
  const modelRow = props.choices.find(
    (candidate) => exactModelChoiceValue(candidate.connectionId, candidate.connectionSlug, candidate.model) === modelSelection.value,
  )?.label ?? props.label;
  const severalConnections = new Set(props.choices.map((candidate) => candidate.connectionSlug)).size > 1;

  return (
    <DropdownMenu
      placement="above"
      menuWidth={240}
      isMenuOpen={open}
      onOpenChange={(next) => {
        if (props.isReadOnly && next) return;
        setOpen(next);
      }}
      button={{
        // With visible `children`, Astryx makes `label` the accessible name and
        // overrides any `aria-label`, so the name must carry the action too.
        label: `${copy.switchAriaLabel}: ${triggerLabel}`,
        variant: 'ghost',
        size: 'sm',
        isDisabled: props.disabled,
        tooltip: props.disabledReason ?? copy.switchAriaLabel,
        className: 'maka-model-switcher-trigger maka-composer-options-trigger',
        endContent: <Icon icon="chevronDown" size="sm" color="secondary" />,
        children: (
          <span className="maka-composer-options-label">
            <span className="maka-composer-model-label">{props.label}</span>
            {triggerDetails ? <span className="maka-composer-options-details">{triggerDetails}</span> : null}
          </span>
        ),
      }}
    >
      {props.thinkingLevels && props.thinkingLevels.length > 0 && props.onThinkingLevelChange ? (
        <DropdownMenuSubMenu label={<OptionRow label={copy.effort} value={effortRow} />}>
          <DropdownMenuRadioGroup
            label={copy.effort}
            value={effortSelection.value}
            onChange={(value) => { void effortSelection.onChange(value); }}
          >
            <DropdownMenuRadioItem value={DEFAULT_EFFORT} label={copy.defaultLevel} />
            {props.thinkingLevels.map((level) => (
              <DropdownMenuRadioItem key={level} value={level} label={copy.level[level]} />
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubMenu>
      ) : null}
      <DropdownMenuSubMenu label={<OptionRow label={copy.model} value={modelRow} />}>
        {noticeShown ? (
          <DropdownMenuItem
            label={copy.switchWarning}
            description={copy.switchWarningDismiss}
            hasCloseOnSelect={false}
            onClick={() => {
              if (!props.sessionId) return;
              setAcknowledgedSessions((current) => new Set(current).add(props.sessionId!));
            }}
          />
        ) : null}
        <DropdownMenuRadioGroup
          label={copy.model}
          value={modelSelection.value || undefined}
          onChange={(value) => { void modelSelection.onChange(value); }}
        >
          {props.choices.map((candidate) => {
            const value = exactModelChoiceValue(candidate.connectionId, candidate.connectionSlug, candidate.model);
            const connection = severalConnections ? candidate.connectionName ?? candidate.providerLabel : undefined;
            return (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                label={connection ? `${candidate.label} · ${connection}` : candidate.label}
                icon={props.renderProviderMark?.(candidate.providerType)}
              />
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubMenu>
    </DropdownMenu>
  );
}
