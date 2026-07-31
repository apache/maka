import { useEffect, useRef, useState, type Ref } from 'react';
import { Check, Copy, Eye, EyeOff } from '@maka/ui/icons';
import {
  IconButton,
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
 * (bot tokens / app secrets, provider API keys, Open Gateway token,
 * network proxy password, web search API key) so the visibility +
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
  ariaLabel?: string;
  description?: string;
  ariaDescribedBy?: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onBlur?(): void;
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
    <div className="settingsPasswordField">
      <TextInput
        ref={props.inputRef}
        type={visible ? 'text' : 'password'}
        value={props.value}
        onChange={(value) => props.onChange(value)}
        onBlur={props.onBlur}
        placeholder={props.placeholder}
        label={props.ariaLabel ?? props.placeholder ?? 'Password'}
        description={props.description}
              isLabelHidden
        aria-describedby={props.ariaDescribedBy}
        isDisabled={props.disabled}
      />
      <div className="settingsPasswordActions">
        {props.value && !props.disabled && (
          <IconButton
            variant="ghost"
            size="sm"
            isDisabled={copying}
            onClick={() => void copyValue()}
            label={copying ? copy.copying : justCopied ? copy.copied : copy.copy}
            icon={justCopied
              ? <Check size={16} aria-hidden="true" />
              : <Copy size={16} aria-hidden="true" />}
          />
        )}
        <IconButton
          variant="ghost"
          size="sm"
          onClick={() => setVisible((current) => !current)}
          isDisabled={props.disabled}
          label={visible ? copy.hide : copy.show}
          aria-pressed={visible}
          icon={visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        />
      </div>
    </div>
  );
}
