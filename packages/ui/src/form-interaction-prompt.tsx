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
import type { FormRequestEvent } from '@maka/core/events';
import type { InteractionFormField, InteractionFormResponse } from '@maka/core/interaction';
import { Button, CheckboxInput, RadioList, RadioListItem, TextInput } from '@astryxdesign/core';
import { getConversationCopy } from './conversation-copy.js';
import {
  buildInteractionFormResponse,
  createInteractionFormDrafts,
  interactionFormFieldDraftIsValid,
  type InteractionFormFieldDraft,
} from './form-interaction-prompt-state.js';
import { useUiLocale } from './locale-context.js';
import { useMountedRef } from './use-mounted-ref.js';

export function FormInteractionPrompt(props: {
  request: FormRequestEvent;
  onRespond(response: InteractionFormResponse): void | Promise<void>;
}) {
  const copy = getConversationCopy(useUiLocale()).forms;
  const titleId = useId();
  const [drafts, setDrafts] = useState<InteractionFormFieldDraft[]>(
    () => createInteractionFormDrafts(props.request.fields),
  );
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [responsePending, setResponsePending] = useState(false);
  const responsePendingRef = useRef(false);
  const activeRequestIdRef = useRef(props.request.requestId);
  const mountedRef = useMountedRef();

  useEffect(() => {
    activeRequestIdRef.current = props.request.requestId;
    setDrafts(createInteractionFormDrafts(props.request.fields));
    setSubmitAttempted(false);
    responsePendingRef.current = false;
    setResponsePending(false);
  }, [props.request.fields, props.request.requestId]);

  function updateDraft(index: number, next: InteractionFormFieldDraft) {
    setDrafts((current) => current.map((draft, candidateIndex) => candidateIndex === index ? next : draft));
  }

  async function respond(response: InteractionFormResponse) {
    if (responsePendingRef.current) return;
    const requestId = props.request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      await props.onRespond(response);
    } finally {
      if (activeRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (mountedRef.current) setResponsePending(false);
      }
    }
  }

  function accept() {
    const response = buildInteractionFormResponse(props.request, drafts);
    if (!response) {
      setSubmitAttempted(true);
      return;
    }
    void respond(response);
  }

  const requester = props.request.requester.source
    ? copy.requesterWithSource(props.request.requester.name, props.request.requester.source)
    : copy.requester(props.request.requester.name);

  return (
    <section
      className="maka-composer-interaction maka-form-interaction-prompt composer"
      role="region"
      aria-labelledby={titleId}
    >
      <div className="maka-composer-interaction-inner agents-parchment-paper-surface">
        <header className="maka-interaction-header maka-form-interaction-header">
          <h2 className="maka-interaction-title" id={titleId}>{props.request.message}</h2>
          <p>{requester}</p>
        </header>

        <div className="maka-form-interaction-fields">
          {props.request.fields.map((field, index) => {
            const draft = drafts[index];
            if (!draft) return null;
            const invalid = submitAttempted && !interactionFormFieldDraftIsValid(field, draft);
            return (
              <div className="maka-form-interaction-field" key={field.name}>
                <div className="maka-form-interaction-field-heading">
                  <span>{field.label}</span>
                  <span>{field.required ? copy.required : copy.optional}</span>
                </div>
                {field.description ? <p className="maka-form-interaction-field-description">{field.description}</p> : null}
                {!field.required ? (
                  <CheckboxInput
                    label={copy.include(field.label)}
                    value={draft.included}
                    isDisabled={responsePending}
                    onChange={(included) => updateDraft(index, { ...draft, included })}
                  />
                ) : null}
                {draft.included ? renderFormControl({
                  field,
                  draft,
                  disabled: responsePending,
                  copy,
                  onChange: (value) => updateDraft(index, { ...draft, value }),
                }) : null}
                {invalid ? <p className="maka-form-interaction-error" role="alert">{copy.invalid}</p> : null}
              </div>
            );
          })}
        </div>

        <footer className="maka-interaction-actions maka-form-interaction-actions">
          <div>
            <Button
              variant="ghost"
              isDisabled={responsePending}
              onClick={() => void respond({ requestId: props.request.requestId, action: 'cancel' })}
              label={copy.cancel}
            />
          </div>
          <div className="maka-form-interaction-primary-actions">
            <Button
              variant="ghost"
              isDisabled={responsePending}
              onClick={() => void respond({ requestId: props.request.requestId, action: 'decline' })}
              label={copy.decline}
            />
            <Button
              variant="primary"
              isDisabled={responsePending}
              onClick={accept}
              label={responsePending ? copy.submitting : copy.accept}
            />
          </div>
        </footer>
      </div>
    </section>
  );
}

function renderFormControl(props: {
  field: InteractionFormField;
  draft: InteractionFormFieldDraft;
  disabled: boolean;
  copy: ReturnType<typeof getConversationCopy>['forms'];
  onChange(value: InteractionFormFieldDraft['value']): void;
}) {
  const { field, draft } = props;
  if (field.kind === 'boolean') {
    return (
      <CheckboxInput
        label={props.copy.enabled(field.label)}
        value={draft.value === true}
        isDisabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  if (field.kind === 'single_select') {
    return (
      <RadioList
        label={field.label}
        isLabelHidden
        value={typeof draft.value === 'string' ? draft.value : ''}
        isDisabled={props.disabled}
        onChange={props.onChange}
      >
        {field.options.map((option) => (
          <RadioListItem key={option.value} value={option.value} label={option.label} />
        ))}
      </RadioList>
    );
  }
  if (field.kind === 'multi_select') {
    const selected = Array.isArray(draft.value) ? draft.value : [];
    return (
      <div className="maka-form-interaction-checkboxes" role="group" aria-label={field.label}>
        {field.options.map((option) => (
          <CheckboxInput
            key={option.value}
            label={option.label}
            value={selected.includes(option.value)}
            isDisabled={props.disabled}
            onChange={(checked) => props.onChange(
              checked ? [...selected, option.value] : selected.filter((value) => value !== option.value),
            )}
          />
        ))}
      </div>
    );
  }
  return (
    <TextInput
      label={field.label}
      isLabelHidden
      value={typeof draft.value === 'string' ? draft.value : ''}
      isDisabled={props.disabled}
      placeholder={field.kind === 'string' ? props.copy.enterValue : props.copy.enterNumber}
      onChange={props.onChange}
      width="100%"
    />
  );
}
