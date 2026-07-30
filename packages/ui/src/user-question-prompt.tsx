import { useEffect, useId, useRef, useState } from 'react';
import type { UserQuestionRequestEvent, UserQuestionResponse } from '@maka/core';
import { ChoiceCard, ChoiceCardGroup } from './primitives/choice-card.js';
import { Input } from './primitives/input.js';
import { Pencil } from './icons.js';
import { Button } from './ui.js';
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
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useMountedRef();

  useEffect(() => {
    activeRequestIdRef.current = props.request.requestId;
    setQuestionIndex(0);
    setDrafts(createQuestionDrafts(props.request.questions));
    responsePendingRef.current = false;
    setResponsePending(false);
  }, [props.request.requestId, props.request.questions]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => firstOptionRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [questionIndex, props.request.requestId, props.request.questions]);

  const question = props.request.questions[questionIndex];
  if (!question) return null;
  const draft = drafts[questionIndex] ?? null;
  const selectedValue = draft?.kind === 'option' ? `option:${draft.optionIndex}` : '';
  const interactionDisabled = Boolean(props.stopPending) || responsePending;
  const canContinue = canLeaveQuestion(draft) && !interactionDisabled;
  const isLast = questionIndex === props.request.questions.length - 1;

  function updateDraft(next: QuestionAnswerDraft) {
    setDrafts((current) => current.map((candidate, index) => index === questionIndex ? next : candidate));
  }

  function select(value: string) {
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
          <ChoiceCardGroup
            aria-label={question.question}
            className="maka-question-choice-group"
            value={selectedValue}
            onValueChange={select}
          >
            {question.options.map((option, optionIndex) => (
              <ChoiceCard
                ref={optionIndex === 0 ? firstOptionRef : undefined}
                className="maka-question-option"
                value={`option:${optionIndex}`}
                key={`${optionIndex}:${option.label}`}
                disabled={interactionDisabled}
              >
                <span className="maka-question-radio" aria-hidden="true" />
                <span className="maka-question-option-copy">
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
              </ChoiceCard>
            ))}
          </ChoiceCardGroup>
          <label
            className="maka-question-other-field"
            data-selected={draft?.kind === 'other' ? '' : undefined}
          >
            <Pencil className="maka-question-other-icon" aria-hidden="true" />
            <Input
              unstyled
              aria-label={copy.otherAriaLabel}
              className="maka-question-other-input"
              placeholder={copy.otherPlaceholder}
              value={draft?.kind === 'other' ? draft.value : ''}
              disabled={interactionDisabled}
              onChange={(event) => updateDraft({ kind: 'other', value: event.currentTarget.value })}
            />
          </label>
        </div>

        <footer className="maka-interaction-actions maka-question-actions">
          <Button
            type="button"
            variant="ghost"
            size="md"
            disabled={props.stopPending}
            onClick={() => void props.onStop()}
          >
            {props.stopPending ? copy.stopping : copy.stop}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="md"
            disabled={questionIndex === 0 || interactionDisabled}
            onClick={() => setQuestionIndex((current) => current - 1)}
          >
            {copy.previous}
          </Button>
          <Button
            type="button"
            variant="default"
            size="md"
            disabled={!canContinue}
            onClick={() => isLast ? void submit() : setQuestionIndex((current) => current + 1)}
          >
            {responsePending ? copy.submitting : isLast ? copy.submit : copy.next}
          </Button>
        </footer>
      </div>
    </section>
  );
}
