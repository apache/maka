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

import { useEffect, useRef, useState } from 'react';
import { ICON_SIZE, Check, Copy, Eye, EyeOff } from '@maka/ui/icons';
import {
  IconButton,
  InputGroup,
  InputGroupText,
  type InputGroupProps,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { useActionGuard } from './use-action-guard';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';

/**
 * PR-BOT-SETTINGS-PASSWORD-EYE-0 / PR-BOT-SETTINGS-PASSWORD-COPY-0 /
 * PR-SETTINGS-PASSWORD-INPUT-REACH-0 (WAWQAQ msg `51c7b4ff` screenshots):
 * masked text input with a trailing Eye / EyeOff toggle and an
 * optional Copy button. Shared across Settings credential surfaces
 * (bot tokens / app secrets, provider API keys, network proxy password,
 * web search API key) so the visibility +
 * clipboard affordance is consistent.
 *
 * Initial state is masked. Toggle and copy are both real focusable
 * buttons so keyboard users can flip or copy without leaving the
 * field. Clipboard failure is visible because these fields often hold
 * credentials; a silent copy miss looks like the user copied a secret
 * when the OS actually rejected it.
 */
export function PasswordInput(props: {
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  label: string;
  isLabelHidden?: boolean;
  description?: string;
  status?: InputGroupProps['status'];
  isRequired?: boolean;
  isOptional?: boolean;
  isDisabled?: boolean;
  onBlur?(): void;
  hasAutoFocus?: boolean;
}) {
  const copy = getSettingsPreferencesCopy(useUiLocale()).password;
  const toast = useToast();
  const [visible, setVisible] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyGuard = useActionGuard<'copy'>();
  const mountedRef = useMountedRef();
  const copyFeedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = null;
      }
    };
  }, []);

  function showCopiedFeedback() {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    setJustCopied(true);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      if (mountedRef.current) setJustCopied(false);
    }, 1200);
  }

  async function copyValue() {
    if (!props.value) return;
    if (!copyGuard.begin('copy')) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(props.value);
      if (mountedRef.current) showCopiedFeedback();
    } catch {
      if (mountedRef.current) toast.error(copy.copyFailed, copy.clipboardUnavailable);
    } finally {
      copyGuard.finish();
      if (mountedRef.current) setCopying(false);
    }
  }
  return (
    // The marker rides on the group label because it is the only one: a
    // TextInput inside an InputGroup returns its bare input wrapper and renders
    // no Field at all, so its own `isRequired` produces no marker anywhere. It
    // still carries the prop, because that input is what `aria-required` is
    // written on, and the group's `aria-labelledby` is what names it.
    <InputGroup
      label={props.label}
      description={props.description}
      isLabelHidden={props.isLabelHidden}
      isDisabled={props.isDisabled}
      isRequired={props.isRequired}
      isOptional={props.isOptional}
      status={props.status}
    >
      <TextInput
        type={visible ? 'text' : 'password'}
        value={props.value}
        onChange={(value) => props.onChange(value)}
        onBlur={props.onBlur}
        placeholder={props.placeholder}
        label={copy.value}
        isLabelHidden
        isRequired={props.isRequired}
        isDisabled={props.isDisabled}
        status={props.status ? { type: props.status.type } : undefined}
        hasAutoFocus={props.hasAutoFocus}
      />
      {/* InputGroupText: the sanctioned addon segment — bare IconButtons break the group's caps. */}
      <InputGroupText>
        {props.value && !props.isDisabled && (
          <IconButton
            variant="ghost"
            size="sm"
            isDisabled={copying}
            onClick={() => void copyValue()}
            label={copying ? copy.copying : justCopied ? copy.copied : copy.copy}
            icon={justCopied
              ? <Check size={ICON_SIZE.chrome} aria-hidden="true" />
              : <Copy size={ICON_SIZE.chrome} aria-hidden="true" />}
          />
        )}
        <IconButton
          variant="ghost"
          size="sm"
          onClick={() => setVisible((current) => !current)}
          isDisabled={props.isDisabled}
          label={visible ? copy.hide : copy.show}
          aria-pressed={visible}
          icon={visible ? <EyeOff size={ICON_SIZE.chrome} aria-hidden="true" /> : <Eye size={ICON_SIZE.chrome} aria-hidden="true" />}
        />
      </InputGroupText>
    </InputGroup>
  );
}
