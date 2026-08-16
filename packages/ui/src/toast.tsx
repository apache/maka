// packages/ui/src/toast.tsx
//
// In-app toast notification system + Promise-returning confirm dialog. Both
// share a single context so a feature flow can chain them — e.g. ask for
// confirmation, then surface a toast with an Undo action.
//
// Why we don't keep using `window.confirm` / `window.alert` / `window.prompt`:
//   - Native dialogs block the renderer's event loop and can't be themed.
//   - The look-and-feel never matches the rest of the app.
//   - macOS IME and accessibility behavior with native prompts is uneven.
//
// Astryx owns the layer viewport, toast lifecycle/visuals, and alert-dialog
// semantics. Maka keeps only the product API and the confirmation queue.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertDialog as AstryxAlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button as AstryxButton } from '@astryxdesign/core/Button';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import {
  useToast as useAstryxToast,
  type ToastDismissFn,
} from '@astryxdesign/core/Toast';
import { ICON_SIZE, AlertCircle, AlertTriangle, CheckCircle2, Info } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastErrorAction {
  label: string;
  onClick(
    input: Pick<ToastInput, 'title' | 'description' | 'diagnosticDetails' | 'diagnosticTarget'>,
  ): void;
}

export interface ToastDiagnosticTarget {
  sessionId: string;
  turnId: string;
  eventId: string;
}

export interface ToastInput {
  title: string;
  description?: string;
  diagnosticDetails?: string;
  diagnosticTarget?: ToastDiagnosticTarget;
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms. 0 disables the timer. Default 4000. */
  duration?: number;
  action?: ToastAction;
}

export interface ConfirmInput {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface ToastApi {
  toast(input: ToastInput): string;
  success(title: string, description?: string): string;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: ToastDiagnosticTarget,
  ): string;
  info(title: string, description?: string): string;
  warning(title: string, description?: string): string;
  confirm(input: ConfirmInput): Promise<boolean>;
  dismiss(id: string): void;
}

interface PendingConfirm extends ConfirmInput {
  id: string;
  resolve(result: boolean): void;
}

interface ActiveConfirm {
  request: PendingConfirm;
  phase: 'mounting' | 'open' | 'closing';
  result?: boolean;
}

const DEFAULT_DURATION = 4000;
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider(props: { children: ReactNode; errorAction?: ToastErrorAction }) {
  return (
    <LayerProvider toast={{ position: 'bottomEnd' }}>
      <ToastController errorAction={props.errorAction}>{props.children}</ToastController>
    </LayerProvider>
  );
}

function ToastController(props: { children: ReactNode; errorAction?: ToastErrorAction }) {
  const showToast = useAstryxToast();
  const [confirmState, setConfirmState] = useState<ActiveConfirm | null>(null);
  const activeConfirmRef = useRef<PendingConfirm | null>(null);
  const confirmQueueRef = useRef<PendingConfirm[]>([]);
  const dismissByIdRef = useRef(new Map<string, ToastDismissFn>());
  const idSeed = useRef(0);

  const push = useCallback(
    (input: ToastInput): string => {
      const id = `t${++idSeed.current}`;
      let dismissCurrent: ToastDismissFn | undefined;
      const duration = input.duration ?? DEFAULT_DURATION;
      const errorAction = props.errorAction;
      const actions = [
        input.action,
        input.variant === 'error' && errorAction
          ? {
              label: errorAction.label,
              onClick: () => errorAction.onClick(input),
            }
          : undefined,
      ].filter((action): action is ToastAction => action !== undefined);
      dismissCurrent = showToast({
        uniqueID: id,
        body: <ToastBody input={input} />,
        type: input.variant === 'error' ? 'error' : 'info',
        isAutoHide: duration > 0,
        autoHideDuration: duration > 0 ? duration : DEFAULT_DURATION,
        endContent: actions.length > 0 ? (
          <HStack gap={1}>
            {actions.map((action, index) => (
              <AstryxButton
                key={`${index}:${action.label}`}
                variant="ghost"
                size="sm"
                label={action.label}
                onClick={() => {
                  action.onClick();
                  dismissCurrent?.();
                }}
              />
            ))}
          </HStack>
        ) : undefined,
        onHide: () => {
          dismissByIdRef.current.delete(id);
        },
      });
      dismissByIdRef.current.set(id, dismissCurrent);
      return id;
    },
    [props.errorAction, showToast],
  );

  const dismiss = useCallback((id: string) => {
    dismissByIdRef.current.get(id)?.();
  }, []);

  const confirm = useCallback((input: ConfirmInput): Promise<boolean> => {
    return new Promise((resolve) => {
      const request: PendingConfirm = { id: `c${++idSeed.current}`, ...input, resolve };
      if (activeConfirmRef.current) {
        confirmQueueRef.current.push(request);
        return;
      }
      activeConfirmRef.current = request;
      setConfirmState({ request, phase: 'mounting' });
    });
  }, []);

  const requestConfirmResult = useCallback(
    (result: boolean) => {
      const current = activeConfirmRef.current;
      if (!current) return;
      setConfirmState((state) => {
        if (
          !state ||
          state.request !== current ||
          state.phase !== 'open'
        ) {
          return state;
        }
        return { ...state, phase: 'closing', result };
      });
    },
    [],
  );

  useEffect(() => {
    if (!confirmState) return;
    if (confirmState.phase === 'mounting') {
      const frame = window.requestAnimationFrame(() => {
        setConfirmState((state) =>
          state?.request === confirmState.request &&
          state.phase === 'mounting'
            ? { ...state, phase: 'open' }
            : state,
        );
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (confirmState.phase !== 'closing') return;
    const frame = window.requestAnimationFrame(() => {
      const current = activeConfirmRef.current;
      if (!current || current !== confirmState.request) return;
      activeConfirmRef.current = null;
      current.resolve(confirmState.result ?? false);
      const next = confirmQueueRef.current.shift() ?? null;
      activeConfirmRef.current = next;
      setConfirmState(
        next ? { request: next, phase: 'mounting' } : null,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [confirmState]);

  useEffect(() => {
    return () => {
      activeConfirmRef.current?.resolve(false);
      activeConfirmRef.current = null;
      for (const pending of confirmQueueRef.current) {
        pending.resolve(false);
      }
      confirmQueueRef.current = [];
      dismissByIdRef.current.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast: push,
      success: (title, description) => push({ title, description, variant: 'success' }),
      error: (title, description, diagnosticDetails, diagnosticTarget) =>
        push({
          title,
          description,
          diagnosticDetails,
          diagnosticTarget,
          variant: 'error',
          duration: 6000,
        }),
      info: (title, description) => push({ title, description, variant: 'info' }),
      warning: (title, description) => push({ title, description, variant: 'warning' }),
      confirm,
      dismiss,
    }),
    [push, confirm, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {props.children}
      {confirmState && (
        <ConfirmDialog
          key={confirmState.request.id}
          request={confirmState.request}
          isOpen={confirmState.phase === 'open'}
          onResolve={requestConfirmResult}
        />
      )}
    </ToastContext.Provider>
  );
}

/**
 * Read the toast API from context. Throws when called outside a provider so
 * we don't silently swallow notifications during refactors.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside a <ToastProvider>');
  return ctx;
}

const VARIANT_ICON: Record<ToastVariant, ReactNode> = {
  info: <Info size={ICON_SIZE.chrome} aria-hidden="true" />,
  success: <CheckCircle2 size={ICON_SIZE.chrome} aria-hidden="true" />,
  warning: <AlertTriangle size={ICON_SIZE.chrome} aria-hidden="true" />,
  error: <AlertCircle size={ICON_SIZE.chrome} aria-hidden="true" />,
};

function ToastBody({ input }: { input: ToastInput }) {
  const variant = input.variant ?? 'info';
  return (
    <HStack gap={2} vAlign="start">
      <span aria-hidden="true">{VARIANT_ICON[variant]}</span>
      <VStack gap={0.5}>
        <Text type="label" weight="semibold" display="block">{input.title}</Text>
        {input.description && (
          <Text type="supporting" display="block">{input.description}</Text>
        )}
      </VStack>
    </HStack>
  );
}

function ConfirmDialog(props: {
  request: PendingConfirm;
  isOpen: boolean;
  onResolve(result: boolean): void;
}) {
  const copy = getSharedUiCopy(useUiLocale()).toast;
  const {
    title,
    description,
    confirmLabel = copy.confirm,
    cancelLabel = copy.cancel,
    destructive = false,
  } = props.request;

  return (
    <AstryxAlertDialog
      className="maka-confirm-modal"
      isOpen={props.isOpen}
      onOpenChange={(isOpen) => {
        if (!isOpen) props.onResolve(false);
      }}
      title={title}
      description={description ?? ''}
      cancelLabel={cancelLabel}
      actionLabel={confirmLabel}
      actionVariant={destructive ? 'destructive' : 'primary'}
      onAction={() => props.onResolve(true)}
    />
  );
}
