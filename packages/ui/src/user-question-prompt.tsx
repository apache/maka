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
  createQuestionWizardState,
  writeQuestionWizardProgress,
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
  // Resume from the per-request cache so switching sessions and back does not
  // restart the wizard at the first question. The progress and the request it
  // belongs to live in ONE state object: the persistence effect below then
  // always writes under the correct request, even on the commit where the
  // request prop just changed and the reset effect has only scheduled the
  // switch.
  const [wizard, setWizard] = useState(() => createQuestionWizardState(props.request));
  const [responseError, setResponseError] = useState<string>();
  const [responsePending, setResponsePending] = useState(false);
  const responsePendingRef = useRef(false);
  const activeRequestIdRef = useRef(props.request.requestId);
  const inputRef = useRef<ChatComposerInputHandle>(null);
  const mountedRef = useMountedRef();

  // A new request replaces the wizard — but a remount with the SAME request
  // (session switch round trip) must not: the guard skips the replacement and
  // the lazy initializer above already restored the cached progress.
  const previousRequestIdRef = useRef(props.request.requestId);
  useEffect(() => {
    activeRequestIdRef.current = props.request.requestId;
    if (previousRequestIdRef.current === props.request.requestId) {
      // Same request under a new object (no producer does this today): follow
      // it, so progress is written under the object the queue now holds.
      setWizard((current) => current.request === props.request ? current : { ...current, request: props.request });
      return;
    }
    previousRequestIdRef.current = props.request.requestId;
    setResponseError(undefined);
    setWizard(createQuestionWizardState(props.request));
    responsePendingRef.current = false;
    setResponsePending(false);
  }, [props.request]);

  // Keep the cache in sync so a later remount resumes exactly here. Keyed by
  // the state's own request, never the prop's — see the useState comment. The
  // prompt never clears the entry: the interaction queue drops the request
  // object when the runtime settles it, and the cache follows.
  useEffect(() => {
    writeQuestionWizardProgress(wizard.request, wizard);
  }, [wizard]);

  // On the commit right after a request switch the reset effect above has not
  // run yet; render the new request's own state rather than the previous
  // request's progress under the new questions.
  const view = wizard.request.requestId === props.request.requestId ? wizard : createQuestionWizardState(props.request);

  const question = props.request.questions[view.questionIndex];
  if (!question) return null;
  const draft = view.drafts[view.questionIndex] ?? null;
  const selectedValue = draft?.kind === 'option' ? `option:${draft.optionIndex}` : '';
  const interactionDisabled = Boolean(props.stopPending) || responsePending;
  const isLast = view.questionIndex === props.request.questions.length - 1;

  function updateDraft(next: QuestionAnswerDraft) {
    setWizard((current) => ({
      ...current,
      drafts: current.drafts.map((candidate, index) => index === current.questionIndex ? next : candidate),
    }));
  }

  // The input text is the free-form answer: it outranks a committed "other"
  // draft, and clearing it drops that draft entirely.
  function commitDrafts(text: string): QuestionAnswerDraft[] {
    const trimmed = text.trim();
    return view.drafts.map((candidate, index) => index !== view.questionIndex ? candidate
      : trimmed ? { kind: 'other', value: trimmed }
      : candidate?.kind === 'other' ? null : candidate);
  }

  function select(value: string) {
    setWizard((current) => ({
      ...current,
      drafts: current.drafts.map((candidate, index) => index === current.questionIndex
        ? { kind: 'option' as const, optionIndex: Number(value.slice('option:'.length)) }
        : candidate),
      answerText: '',
    }));
  }

  function onAnswerChange(value: string) {
    setWizard((current) => ({
      ...current,
      answerText: value,
      drafts: value.trim() && current.drafts[current.questionIndex]?.kind === 'option'
        ? current.drafts.map((candidate, index) => index === current.questionIndex ? null : candidate)
        : current.drafts,
    }));
  }

  function moveTo(nextIndex: number, committed: QuestionAnswerDraft[]) {
    const next = committed[nextIndex];
    setWizard((current) => ({
      ...current,
      drafts: committed,
      questionIndex: nextIndex,
      answerText: next?.kind === 'other' ? next.value : '',
    }));
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
    const committed = commitDrafts(view.answerText);
    if (isLast) void submit(committed);
    else moveTo(view.questionIndex + 1, committed);
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
              {props.request.questions.length > 1 ? <span className="maka-question-progress">{view.questionIndex + 1} / {props.request.questions.length}</span> : null}
            </div>
            <ChoicePanel
              key={view.questionIndex}
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
              value={view.answerText}
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
          {view.questionIndex > 0 ? (
            <Button
              variant="ghost"
              isDisabled={interactionDisabled}
              onClick={() => moveTo(view.questionIndex - 1, commitDrafts(view.answerText))}
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
