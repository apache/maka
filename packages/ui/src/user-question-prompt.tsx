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

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { UserQuestionRequestEvent } from '@maka/core/events';
import type { UserQuestionResponse } from '@maka/core/user-question';
import {
  Button,
  ChatComposer,
  ChatComposerInput,
  isImeKeyEvent,
  type ChatComposerInputHandle,
} from '@astryxdesign/core';
import { ChoicePanel } from './choice-panel.js';
import { useMountedRef } from './use-mounted-ref.js';
import {
  buildUserQuestionResponse,
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
  const [answerText, setAnswerText] = useState('');
  const [responseError, setResponseError] = useState<string>();
  const [responsePending, setResponsePending] = useState(false);
  const responsePendingRef = useRef(false);
  const activeRequestIdRef = useRef(props.request.requestId);
  const inputRef = useRef<ChatComposerInputHandle>(null);
  const mountedRef = useMountedRef();

  useEffect(() => {
    activeRequestIdRef.current = props.request.requestId;
    setResponseError(undefined);
    setQuestionIndex(0);
    setDrafts(createQuestionDrafts(props.request.questions));
    setAnswerText('');
    responsePendingRef.current = false;
    setResponsePending(false);
  }, [props.request.requestId, props.request.questions]);

  const question = props.request.questions[questionIndex];
  if (!question) return null;
  const draft = drafts[questionIndex] ?? null;
  const selectedValue = draft?.kind === 'option' ? `option:${draft.optionIndex}` : '';
  const interactionDisabled = Boolean(props.stopPending) || responsePending;
  const isLast = questionIndex === props.request.questions.length - 1;

  function updateDraft(next: QuestionAnswerDraft) {
    setDrafts((current) => current.map((candidate, index) => index === questionIndex ? next : candidate));
  }

  // The input text is the free-form answer: it outranks a committed "other"
  // draft, and clearing it drops that draft entirely.
  function commitDrafts(text: string): QuestionAnswerDraft[] {
    const trimmed = text.trim();
    return drafts.map((candidate, index) => index !== questionIndex ? candidate
      : trimmed ? { kind: 'other', value: trimmed }
      : candidate?.kind === 'other' ? null : candidate);
  }

  function select(value: string) {
    updateDraft({ kind: 'option', optionIndex: Number(value.slice('option:'.length)) });
    setAnswerText('');
  }

  function onAnswerChange(value: string) {
    setAnswerText(value);
    if (value.trim() && draft?.kind === 'option') updateDraft(null);
  }

  function moveTo(nextIndex: number, committed: QuestionAnswerDraft[]) {
    setDrafts(committed);
    setQuestionIndex(nextIndex);
    const next = committed[nextIndex];
    setAnswerText(next?.kind === 'other' ? next.value : '');
  }

  // Enter submits through the onKeyDown seam rather than the input's built-in
  // submit, which clears the editor even when the response fails or is still
  // pending — the typed answer must stay editable for retry.
  function onInputKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' || event.shiftKey || isImeKeyEvent(event.nativeEvent)) return;
    event.preventDefault();
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    confirm();
  }

  function confirm() {
    if (interactionDisabled) return;
    const committed = commitDrafts(answerText);
    if (isLast) void submit(committed);
    else moveTo(questionIndex + 1, committed);
  }

  async function submit(committed: QuestionAnswerDraft[]) {
    if (responsePendingRef.current) return;
    const requestId = props.request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    setResponseError(undefined);
    try {
      await props.onRespond(buildUserQuestionResponse(props.request, committed));
    } catch (reason) {
      if (mountedRef.current && activeRequestIdRef.current === requestId) setResponseError(reason instanceof Error ? reason.message : String(reason));
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
      <ChatComposer
        className="maka-composer-astryx"
        // onSubmit is required but unreachable: the shell gates it on its own
        // internal value, which stays empty for a controlled input, and the
        // input below owns Enter through onKeyDown anyway.
        onSubmit={() => {}}
        placeholder={copy.otherPlaceholder}
        status={responseError ? { type: 'error', message: responseError } : undefined}
        input={
          <div className="maka-question-body">
            <div className="maka-interaction-title-row">
              <h2 className="maka-interaction-title" id={titleId}>{question.question}</h2>
              {props.request.questions.length > 1 ? <span className="maka-question-progress">{questionIndex + 1} / {props.request.questions.length}</span> : null}
            </div>
            <ChoicePanel
              key={questionIndex}
              label={question.question}
              value={selectedValue}
              disabled={interactionDisabled}
              onChange={select}
              onConfirm={confirm}
              onEscape={() => inputRef.current?.focus()}
              options={question.options.map((option, index) => ({ value: `option:${index}`, label: option.label, description: option.description }))}
            />
            <ChatComposerInput
              handleRef={inputRef}
              value={answerText}
              onChange={onAnswerChange}
              onKeyDown={onInputKeyDown}
              isDisabled={interactionDisabled}
              hasHistory={false}
              pasteAsToken={false}
              label={copy.otherAriaLabel}
            />
          </div>
        }
        footerActions={<>
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
              onClick={() => moveTo(questionIndex - 1, commitDrafts(answerText))}
              label={copy.previous}
            />
          ) : null}
        </>}
        sendButton={
          <Button
            variant="primary"
            isDisabled={interactionDisabled}
            onClick={confirm}
            label={responsePending ? copy.submitting : isLast ? copy.submit : copy.next}
          />
        }
      />
    </section>
  );
}
