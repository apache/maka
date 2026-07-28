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
// PR6 (#520): toast surface migrated to Base UI Toast (Provider + manager +
// Viewport/Root/Title/Description/Action/Close). The confirm dialog + its
// queue stay hand-written (Base UI Toast has no confirm concept). The
// `useToast()` / `toast.confirm()` API is unchanged so callers don't move.
// `render` props keep the existing <ol>/<li role="alert">/<strong>/<small>/
// <Button> DOM shape so .maka-toast CSS and the toast-position-fixed +
// toast-confirm-keyboard contracts keep holding.

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
import { Toast as BaseToast } from '@base-ui/react/toast';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from './icons.js';
import { AlertDialogContent, AlertDialogRoot, Button } from './ui.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastInput {
  title: string;
  description?: string;
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
  error(title: string, description?: string): string;
  info(title: string, description?: string): string;
  warning(title: string, description?: string): string;
  confirm(input: ConfirmInput): Promise<boolean>;
  dismiss(id: string): void;
}

interface PendingConfirm extends ConfirmInput {
  // Stable id so <ConfirmDialog key={request.id}> remounts on queue advance —
  // AlertDialog `defaultOpen` + `initialFocus` only fire on mount, so without
  // a key the second confirm inherits the first's focus (stuck on the
  // confirm button → Enter mis-confirms a dangerous op).
  id: string;
  resolve(result: boolean): void;
}

const DEFAULT_DURATION = 4000;
const TOAST_POSITION = 'bottom-right';
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider(props: { children: ReactNode }) {
  const toastManager = useMemo(() => BaseToast.createToastManager(), []);
  const [confirmState, setConfirmState] = useState<PendingConfirm | null>(null);
  const activeConfirmRef = useRef<PendingConfirm | null>(null);
  const confirmQueueRef = useRef<PendingConfirm[]>([]);
  const idSeed = useRef(0);

  const push = useCallback(
    (input: ToastInput): string => {
      const id = `t${++idSeed.current}`;
      toastManager.add({
        id,
        title: input.title,
        description: input.description,
        type: input.variant ?? 'info',
        timeout: input.duration ?? DEFAULT_DURATION,
        actionProps: input.action
          ? {
              onClick: () => {
                input.action!.onClick();
                toastManager.close(id);
              },
              children: input.action.label,
            }
          : undefined,
      });
      return id;
    },
    [toastManager],
  );

  const dismiss = useCallback(
    (id: string) => {
      toastManager.close(id);
    },
    [toastManager],
  );

  const confirm = useCallback((input: ConfirmInput): Promise<boolean> => {
    return new Promise((resolve) => {
      const request: PendingConfirm = { id: `c${++idSeed.current}`, ...input, resolve };
      if (activeConfirmRef.current) {
        confirmQueueRef.current.push(request);
        return;
      }
      activeConfirmRef.current = request;
      setConfirmState(request);
    });
  }, []);

  const resolveConfirm = useCallback(
    (result: boolean) => {
      const current = activeConfirmRef.current;
      if (!current) return;
      activeConfirmRef.current = null;
      current.resolve(result);
      const next = confirmQueueRef.current.shift() ?? null;
      activeConfirmRef.current = next;
      setConfirmState(next);
    },
    [],
  );

  useEffect(() => {
    return () => {
      activeConfirmRef.current?.resolve(false);
      activeConfirmRef.current = null;
      for (const pending of confirmQueueRef.current) {
        pending.resolve(false);
      }
      confirmQueueRef.current = [];
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast: push,
      success: (title, description) => push({ title, description, variant: 'success' }),
      error: (title, description) => push({ title, description, variant: 'error', duration: 6000 }),
      info: (title, description) => push({ title, description, variant: 'info' }),
      warning: (title, description) => push({ title, description, variant: 'warning' }),
      confirm,
      dismiss,
    }),
    [push, confirm, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      <BaseToast.Provider toastManager={toastManager} timeout={DEFAULT_DURATION} limit={Number.POSITIVE_INFINITY}>
        {props.children}
        <ToastViewport />
      </BaseToast.Provider>
      {confirmState && (
        <ConfirmDialog key={confirmState.id} request={confirmState} onResolve={resolveConfirm} />
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
  info: <Info size={16} aria-hidden="true" />,
  success: <CheckCircle2 size={16} aria-hidden="true" />,
  warning: <AlertTriangle size={16} aria-hidden="true" />,
  error: <AlertCircle size={16} aria-hidden="true" />,
};

function ToastViewport() {
  const copy = getSharedUiCopy(useUiLocale()).toast;
  const { toasts } = BaseToast.useToastManager();
  if (toasts.length === 0) return null;
  return (
    <BaseToast.Viewport
      render={
        <ol
          className="maka-toast-viewport"
          data-position={TOAST_POSITION}
          role="region"
          aria-live="polite"
          aria-label={copy.notifications}
        />
      }
    >
      {toasts.map((entry) => {
        const variant = (entry.type as ToastVariant) ?? 'info';
        return (
          // role="alert" lets screen readers announce each toast even
          // though the parent <ol> already has aria-live="polite" —
          // browsers / AT pairings handle the live region announce
          // better when the live items themselves carry an alert
          // role rather than relying on the region inheritance.
          <BaseToast.Root
            key={entry.id}
            toast={entry}
            render={
              <li
                className="maka-toast"
                data-variant={variant}
                role="alert"
              />
            }
          >
            <span className="maka-toast-icon" aria-hidden="true">{VARIANT_ICON[variant]}</span>
            <div className="maka-toast-copy">
              <BaseToast.Title render={<strong />}>{entry.title}</BaseToast.Title>
              {entry.description && (
                <BaseToast.Description render={<small />}>{entry.description}</BaseToast.Description>
              )}
            </div>
            {entry.actionProps && (
              <BaseToast.Action
                {...entry.actionProps}
                render={<Button type="button" variant="secondary" size="sm" />}
              />
            )}
            <BaseToast.Close
              aria-label={copy.closeNotification}
              render={<Button type="button" variant="quiet" size="icon-sm" />}
            >
              <X size={14} aria-hidden="true" />
            </BaseToast.Close>
          </BaseToast.Root>
        );
      })}
    </BaseToast.Viewport>
  );
}

function ConfirmDialog(props: { request: PendingConfirm; onResolve(result: boolean): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const copy = getSharedUiCopy(useUiLocale()).toast;
  const {
    title,
    description,
    confirmLabel = copy.confirm,
    cancelLabel = copy.cancel,
    destructive = false,
  } = props.request;

  // Escape / backdrop close = cancel (onResolve(false)). Base UI AlertDialog
  // disables pointer dismissal; Escape triggers onOpenChange(false).
  return (
    <AlertDialogRoot defaultOpen onOpenChange={(open) => { if (!open) props.onResolve(false); }}>
      <AlertDialogContent
        className="maka-modal maka-confirm-modal"
        aria-labelledby="maka-confirm-title"
        aria-describedby={description ? 'maka-confirm-description' : undefined}
        initialFocus={cancelRef}
        showClose={false}
      >
        <div className="maka-modal-header">
          <h2 className="maka-modal-title" id="maka-confirm-title">
            {destructive ? <AlertTriangle size={18} aria-hidden="true" /> : null}
            {title}
          </h2>
          {description && (
            <p className="maka-modal-subtitle" id="maka-confirm-description">{description}</p>
          )}
        </div>
        <div className="maka-modal-footer">
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            onClick={() => props.onResolve(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => props.onResolve(true)}
          >
            {confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
