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

import { useEffect, useId, useRef, useState } from 'react';
import type { UserQuestionRequestEvent } from '@maka/core/events';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { Button, RadioList, RadioListItem, TextInput } from '@astryxdesign/core';
import { useMountedRef } from './use-mounted-ref.js';
import {
  buildUserQuestionResponse,
  canLeaveQuestion,
  createQuestionDrafts,
  type QuestionAnswerDraft,
} from './user-question-prompt-state.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export function UserQuestionPrompt(props: {
  request: UserQuestionRequestEvent;
  onRespond(response: UserQuestionResponse): void | Promise<void>;
  onStop(): void | Promise<void>;
  stopPending?: boolean;
}) {
  const copy = getConversationCopy(useUiLocale()).questions;
  const titleId = useId();
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<QuestionAnswerDraft[]>(() => createQuestionDrafts(props.request.questions));
  const [responsePending, setResponsePending] = useState(false);
  const responsePendingRef = useRef(false);
  const activeRequestIdRef = useRef(props.request.requestId);
  const mountedRef = useMountedRef();

  useEffect(() => {
    activeRequestIdRef.current = props.request.requestId;
    setQuestionIndex(0);
    setDrafts(createQuestionDrafts(props.request.questions));
    responsePendingRef.current = false;
    setResponsePending(false);
  }, [props.request.requestId, props.request.questions]);

  const question = props.request.questions[questionIndex];
  if (!question) return null;
  const draft = drafts[questionIndex] ?? null;
  const selectedValue = draft?.kind === 'option' ? `option:${draft.optionIndex}` : draft?.kind === 'other' ? 'other' : '';
  const interactionDisabled = Boolean(props.stopPending) || responsePending;
  const canContinue = canLeaveQuestion(draft) && !interactionDisabled;
  const isLast = questionIndex === props.request.questions.length - 1;

  function updateDraft(next: QuestionAnswerDraft) {
    setDrafts((current) => current.map((candidate, index) => index === questionIndex ? next : candidate));
  }

  function select(value: string) {
    if (value === 'other') {
      updateDraft({ kind: 'other', value: draft?.kind === 'other' ? draft.value : '' });
      return;
    }
    const optionIndex = Number(value.slice('option:'.length));
    updateDraft({ kind: 'option', optionIndex });
  }

  async function submit() {
    if (responsePendingRef.current || !canLeaveQuestion(draft)) return;
    const requestId = props.request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      await props.onRespond(buildUserQuestionResponse(props.request, drafts));
    } finally {
      if (activeRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (mountedRef.current) setResponsePending(false);
      }
    }
  }

  return (
    <section
      className="maka-composer-interaction maka-user-question-prompt composer"
      role="region"
      aria-labelledby={titleId}
    >
      <div className="maka-composer-interaction-inner agents-parchment-paper-surface">
        <header className="maka-interaction-header">
          <div className="maka-interaction-title-row">
            <h2 className="maka-interaction-title" id={titleId}>{question.question}</h2>
            <span className="maka-question-progress">{questionIndex + 1} / {props.request.questions.length}</span>
          </div>
        </header>

        <div className="maka-question-options">
          <RadioList
            label={question.question}
            isLabelHidden
            value={selectedValue}
            isDisabled={interactionDisabled}
            onChange={select}
          >
            {question.options.map((option, optionIndex) => (
              <RadioListItem
                value={`option:${optionIndex}`}
                key={`${optionIndex}:${option.label}`}
                label={option.label}
                description={option.description}
              />
            ))}
            <RadioListItem
              value="other"
              label={copy.other}
              description={copy.otherDescription}
            />
          </RadioList>
          {draft?.kind === 'other' ? (
            <div className="maka-question-other-answer">
              <TextInput
                label={copy.otherAriaLabel}
                isLabelHidden
                placeholder={copy.otherPlaceholder}
                value={draft.value}
                isDisabled={interactionDisabled}
                onChange={(value) => updateDraft({ kind: 'other', value })}
                width="100%"
                hasAutoFocus
              />
            </div>
          ) : null}
        </div>

        <footer className="maka-interaction-actions maka-question-actions">
          <Button
            variant="ghost"
            isDisabled={props.stopPending}
            onClick={() => void props.onStop()}
            label={props.stopPending ? copy.stopping : copy.stop}
          />
          {questionIndex > 0 ? (
            <Button
              variant="ghost"
              isDisabled={interactionDisabled}
              onClick={() => setQuestionIndex((current) => current - 1)}
              label={copy.previous}
            />
          ) : null}
          <Button
            variant="primary"
            className="maka-question-submit"
            isDisabled={!canContinue}
            onClick={() => (isLast ? void submit() : setQuestionIndex((current) => current + 1))}
            label={responsePending ? copy.submitting : isLast ? copy.submit : copy.next}
          />
        </footer>
      </div>
    </section>
  );
}
