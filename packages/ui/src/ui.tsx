import React, { forwardRef } from 'react';
import { Progress as BaseProgress } from '@base-ui/react/progress';
import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';
import { AlertDialog as AstryxAlertDialog } from '@astryxdesign/core/AlertDialog';
import {
  Dialog as AstryxDialog,
  type DialogProps as AstryxDialogProps,
  type DialogPurpose,
} from '@astryxdesign/core/Dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import {
  useModalFocusLifecycle,
  type ModalFocusTarget,
} from './modal-lifecycle.js';
import { cn } from './utils.js';

export { cn } from './utils.js';

export type PickerTriggerAppearance = 'field' | 'quiet';

// Legacy field recipe retained only for model-picker triggers until their
// owning migration slice moves to Astryx. Form controls no longer consume it.
const inputClasses = [
  'flex min-h-9 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm text-foreground transition-[border-color,box-shadow,background-color]',
  'placeholder:text-foreground-secondary/70',
  'hover:not-focus-visible:border-foreground/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/16',
  'aria-invalid:border-destructive/64 aria-invalid:ring-destructive/16',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

const quietPickerTriggerClasses = [
  'inline-flex shrink-0 items-center',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  'disabled:pointer-events-none disabled:opacity-50',
].join(' ');

/**
 * Picker triggers appear either as form fields or as quiet toolbar controls.
 * The quiet variant intentionally carries only interaction states: its owning
 * surface remains the single source of geometry and visual chrome.
 */
export function pickerTriggerClasses(appearance: PickerTriggerAppearance = 'field'): string {
  return appearance === 'field' ? inputClasses : quietPickerTriggerClasses;
}

// === Base UI style-hook convention (#520 PR5 item 23) =========================
// Every Base UI wrapper in this file exposes `data-slot="<name>"` so CSS can
// target `[data-slot="..."]` (a stable hook that survives className drift);
// the shared primitives in `./primitives/` already do this (accordion / alert /
// badge / …), and new wrappers (Collapsible / Tooltip / …) follow
// the same rule. Hand-written native elements such as `Badge` are out of this
// rule until they retire onto a shared primitive.
//
// Boolean state hooks adopt Base UI's NATIVE attribute-presence form —
// `[data-active]`, `[data-open]`, `[data-checked]`, `[data-selected]`,
// `[data-pressed]`, `[data-highlighted]`, `[data-disabled]` — NOT the
// attribute-value form `[data-active="true"]`. Maka's renderer CSS has zero
// state-attribute selectors today, so adopting Base UI's form breaks nothing
// and avoids maintaining an override layer. Per-component map:
//   Tabs        data-active                 (primitives/tabs.tsx)
//   Select      data-[highlighted] / data-[selected]
//   Toggle      data-[pressed] / data-[disabled]
//   Dialog      data-[open]                 (open state on the root)
//   Tooltip / Popover  data-[open]
//   Progress    (no boolean state)
// CSS var hooks whitelisted for theming: `--anchor-*` (popups),
// `--available-*` (popup max-height), `--active-tab-*` (Tabs indicator).
// `className(state)` function form: deferred — add only when a migration in
// this PR actually needs state-based classes; do not pre-design it.
// ===========================================================================

// #1565 PR 3: the Button COMPONENT is the Astryx primitive now (re-exported
// from index.ts). buttonVariants stays as a LEGACY className recipe only: its
// remaining consumers are controls owned by later slices (Dialog close /
// Toast action / Menu trigger render-props, where composing the Astryx
// Button into a Base UI render-prop would wrap both systems around one
// control). Each owning slice retires its usage; PR 11 deletes the recipe.
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-sm',
    'transition-[background,color,border-color,box-shadow,opacity] duration-150 ease-[var(--ease-out-strong)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'disabled:pointer-events-none disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45',
    '[&_svg]:size-[var(--icon-size,1rem)] [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground font-medium hover:bg-[oklch(from_var(--action)_calc(l_-_0.03)_c_h)] active:bg-[oklch(from_var(--action)_calc(l_-_0.06)_c_h)]',
        secondary: 'border border-border bg-transparent text-foreground font-normal hover:bg-[var(--state-hover-bg)] active:bg-[var(--state-selected-bg)]',
        ghost: 'bg-transparent text-foreground font-normal hover:bg-[var(--state-hover-bg)] active:bg-[var(--state-selected-bg)]',
        destructive: 'bg-destructive text-destructive-foreground font-medium hover:bg-[oklch(from_var(--destructive)_calc(l_-_0.04)_c_h)] active:bg-[oklch(from_var(--destructive)_calc(l_-_0.08)_c_h)]',
        quiet: 'bg-transparent text-foreground-secondary font-normal hover:bg-[var(--state-hover-bg)] hover:text-foreground active:bg-[var(--state-selected-bg)]',
      },
      size: {
        sm: 'h-7 px-2 text-sm',
        md: 'h-8 px-3 text-sm',
        icon: 'h-8 w-8 px-0 text-sm',
        'icon-sm': 'h-7 w-7 px-0 text-sm',
      },
      // #901 follow-up: circular affordance for round icon actions (composer
      // "+" / send). #901 retired the consumer-layer pill CSS
      // (maka-composer-send-button & friends) onto the shared Button but
      // offered no governed replacement for the circle, silently squaring
      // those buttons. The `shape` axis keeps the pill tier on the governed
      // primitive instead of in per-surface CSS. `rounded-full` resolves to
      // --radius-pill per the radius-converge contract.
      shape: {
        default: '',
        pill: 'rounded-full',
      },
    },
    compoundVariants: [
      {
        variant: ['secondary', 'ghost', 'quiet'],
        class: 'aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent',
      },
      {
        variant: 'quiet',
        class: 'aria-disabled:hover:text-foreground-secondary',
      },
      {
        variant: 'default',
        class: 'aria-disabled:hover:bg-primary aria-disabled:active:bg-primary',
      },
      {
        variant: 'destructive',
        class: 'aria-disabled:hover:bg-destructive aria-disabled:active:bg-destructive',
      },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'md',
      shape: 'default',
    },
  },
);

// This legacy class recipe remains only for picker triggers.

interface DialogContextValue {
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  purpose: DialogPurpose;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

interface DialogRootProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(isOpen: boolean): void;
  children?: React.ReactNode;
}

function ModalRoot({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  children,
  purpose,
}: DialogRootProps & { purpose: DialogPurpose }) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isOpen = controlledOpen ?? uncontrolledOpen;
  const context = React.useMemo<DialogContextValue>(
    () => ({
      isOpen,
      purpose,
      onOpenChange(nextOpen) {
        if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
        onOpenChange?.(nextOpen);
      },
    }),
    [controlledOpen, isOpen, onOpenChange, purpose],
  );
  return <DialogContext value={context}>{children}</DialogContext>;
}

export function DialogRoot(props: DialogRootProps) {
  return <ModalRoot {...props} purpose="info" />;
}

export function AlertDialogRoot(props: DialogRootProps) {
  return <ModalRoot {...props} purpose="form" />;
}

function useDialogRoot(): DialogContextValue {
  const context = React.useContext(DialogContext);
  if (!context) throw new Error('DialogContent must be rendered inside DialogRoot');
  return context;
}

interface ModalContentProps
  extends Omit<AstryxDialogProps, 'children' | 'isOpen' | 'onOpenChange' | 'ref'> {
  children?: React.ReactNode;
  initialFocus?: ModalFocusTarget;
  finalFocus?: ModalFocusTarget;
}

type ModalRole = 'dialog' | 'alertdialog';

function createModalContent(defaultRole: ModalRole, defaultPurpose?: DialogPurpose) {
  return forwardRef<HTMLDialogElement, ModalContentProps>(function ModalContent(
    {
      children,
      initialFocus,
      finalFocus,
      purpose,
      role = defaultRole,
      padding = 0,
      ...props
    },
    ref,
  ) {
    const root = useDialogRoot();
    useModalFocusLifecycle({ isOpen: root.isOpen, initialFocus, finalFocus });

    return (
      <AstryxDialog
        {...props}
        ref={ref}
        isOpen={root.isOpen}
        onOpenChange={root.onOpenChange}
        purpose={purpose ?? defaultPurpose ?? root.purpose}
        role={role}
        padding={padding}
      >
        {children}
      </AstryxDialog>
    );
  });
}

export const DialogContent = createModalContent('dialog');
export const AlertDialogContent = createModalContent('alertdialog', 'form');

interface DialogCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  render?: React.ReactElement<Record<string, unknown>>;
}

export function DialogClose({ render, children, onClick, ...props }: DialogCloseProps) {
  const root = useDialogRoot();
  const handleClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
    const renderedOnClick = render?.props.onClick as
      | React.MouseEventHandler<HTMLButtonElement>
      | undefined;
    renderedOnClick?.(event);
    onClick?.(event);
    if (!event.defaultPrevented) root.onOpenChange(false);
  };

  if (render) {
    return React.cloneElement(render, { ...props, onClick: handleClick, children });
  }
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      aria-label={props['aria-label']}
      onClick={handleClick}
    >
      {children}
    </button>
  );
}

export { AstryxAlertDialog as AlertDialog };
export { LayerProvider } from '@astryxdesign/core/Layer';

// Tabs: re-export the shared tab spec primitive (#499 P0-3). The tab spec
// (maka-tab class + underline/pill variants + neutral state tokens) lives in
// primitives/tabs.tsx. ui.tsx used to carry a second hand-rolled set (Base UI
// + bg-muted plate, no variant, dead data-[selected] active selectors — Base
// UI sets data-active) which plan-reminder-panel consumed, bypassing the spec.
// Re-exporting unifies on one primitive so every tab surface gets variant +
// maka-tab + the correct data-active attribute.
export { Tabs as TabsRoot, TabsList, TabsTab as TabsTrigger, TabsPanel } from './primitives/tabs.js';

// =============================================================
// Toggle + ToggleGroup
// =============================================================

export const Toggle = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseToggle>
>(function Toggle({ className, ...props }, ref) {
  return (
    <BaseToggle
      ref={ref}
      className={cn(
        'inline-flex h-8 items-center justify-center rounded-sm bg-transparent px-2.5 text-sm font-medium text-foreground transition-colors',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'data-[pressed]:bg-muted data-[pressed]:text-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      data-slot="toggle"
      {...props}
    />
  );
});

export const ToggleGroup = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseToggleGroup>
>(function ToggleGroup({ className, ...props }, ref) {
  return (
    <BaseToggleGroup
      ref={ref}
      className={cn('inline-flex items-center gap-1 rounded-md bg-muted p-1', className)}
      data-slot="toggle-group"
      {...props}
    />
  );
});

// =============================================================
// Progress
// =============================================================

export const Progress = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseProgress.Root>
>(function Progress({ className, ...props }, ref) {
  return (
    <BaseProgress.Root
      ref={ref}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      data-slot="progress"
      {...props}
    >
      <BaseProgress.Track className="absolute inset-0 overflow-hidden">
        <BaseProgress.Indicator className="block h-full origin-left bg-control transition-transform" />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
});

// Toast — migrated to Base UI Toast in `packages/ui/src/toast.tsx`, exposed
// via the project's `useToast()` / `toast.confirm()` API (PR6 #520). The toast
// surface (Provider + manager + Viewport/Root/Title/Description/Action/Close)
// is Base UI; the confirm dialog + its queue stay hand-written (Base UI Toast
// has no confirm concept) and live in toast.tsx.
