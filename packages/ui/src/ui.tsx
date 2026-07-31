import React, { forwardRef } from 'react';
import { Field as BaseField } from '@base-ui/react/field';
import { Progress as BaseProgress } from '@base-ui/react/progress';
import { Radio as BaseRadio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';
import { AlertDialog as AstryxAlertDialog } from '@astryxdesign/core/AlertDialog';
import {
  Dialog as AstryxDialog,
  type DialogProps as AstryxDialogProps,
  type DialogPurpose,
} from '@astryxdesign/core/Dialog';
import { usePopover, type UsePopoverReturn } from '@astryxdesign/core/Popover';
import { Selector } from '@astryxdesign/core/Selector';
import { mergeRefs } from '@astryxdesign/core/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import {
  useModalFocusLifecycle,
  type ModalFocusTarget,
} from './modal-lifecycle.js';
import { cn } from './utils.js';
import { inputClasses } from './primitives/input.js';

export { cn } from './utils.js';

export type PickerTriggerAppearance = 'field' | 'quiet';

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
// badge / …), and new wrappers (Collapsible / Tooltip / NumberField / …) follow
// the same rule. Hand-written native elements (the legacy `Input` / `Textarea`
// below, and `Badge`) are out of this rule until they retire onto a Base UI
// primitive.
//
// Boolean state hooks adopt Base UI's NATIVE attribute-presence form —
// `[data-active]`, `[data-open]`, `[data-checked]`, `[data-selected]`,
// `[data-pressed]`, `[data-highlighted]`, `[data-disabled]` — NOT the
// attribute-value form `[data-active="true"]`. Maka's renderer CSS has zero
// state-attribute selectors today, so adopting Base UI's form breaks nothing
// and avoids maintaining an override layer. Per-component map:
//   Tabs        data-active                 (primitives/tabs.tsx)
//   Select      data-[highlighted] / data-[selected]
//   Switch      data-[checked] / data-[disabled]
//   Toggle      data-[pressed] / data-[disabled]
//   Radio       data-[checked] / data-[disabled]
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

// #520 item 22: Input, Textarea, inputClasses, bareFieldClasses retired onto
// packages/ui/src/primitives/input.tsx + primitives/textarea.tsx (Base UI
// Input + ported chrome, single element, no span wrapper). Re-exported from
// the barrel via index.ts; number-field imports inputClasses/bareFieldClasses
// from primitives/input.js.

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

interface LegacySelectItem {
  value: string;
  label?: string;
}

interface LegacySelectContextValue {
  value: string | null;
  items: LegacySelectItem[];
  disabled?: boolean;
  setValue(value: string): void;
}

const LegacySelectContext =
  React.createContext<LegacySelectContextValue | null>(null);

/**
 * Frozen compound Select compatibility shell.
 *
 * All Maka call sites use SettingsSelect/PermissionModeSelect, where Astryx
 * Selector owns the full implementation. These exports remain append-only
 * API compatibility: the trigger renders that same Astryx authority and the
 * retired popup marker components contribute no second listbox or layer.
 */
export function SelectRoot(props: {
  children?: React.ReactNode;
  value?: string | null;
  defaultValue?: string | null;
  items?: LegacySelectItem[];
  disabled?: boolean;
  onValueChange?(value: string | null): void;
}) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(
    props.defaultValue ?? null,
  );
  const controlled = props.value !== undefined;
  const value = controlled ? props.value ?? null : uncontrolledValue;
  const context = React.useMemo<LegacySelectContextValue>(
    () => ({
      value,
      items: props.items ?? [],
      disabled: props.disabled,
      setValue(nextValue) {
        if (!controlled) setUncontrolledValue(nextValue);
        props.onValueChange?.(nextValue);
      },
    }),
    [controlled, props.disabled, props.items, props.onValueChange, value],
  );
  return (
    <LegacySelectContext.Provider value={context}>
      {props.children}
    </LegacySelectContext.Provider>
  );
}

export const SelectTrigger = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    appearance?: PickerTriggerAppearance;
  }
>(function SelectTrigger(
  { appearance: _appearance = 'field', className, children: _children, ...props },
  _ref,
) {
  const context = React.useContext(LegacySelectContext);
  if (!context) throw new Error('SelectTrigger must be used inside SelectRoot');
  const label =
    props['aria-label'] ??
    context.items.find((item) => item.value === context.value)?.label ??
    '';
  return (
    <Selector
      label={String(props['aria-label'] ?? label)}
      isLabelHidden
      value={context.value ?? undefined}
      placeholder={label}
      options={context.items}
      onChange={context.setValue}
      isDisabled={context.disabled ?? props.disabled}
      className={className}
    />
  );
});

export function SelectValue(props: {
  children?: React.ReactNode | ((value: string) => React.ReactNode);
}) {
  const context = React.useContext(LegacySelectContext);
  if (!context?.value) return null;
  return typeof props.children === 'function'
    ? props.children(context.value)
    : props.children;
}

export function SelectPortal(_props: { children?: React.ReactNode }) {
  return null;
}

export function SelectPositioner(_props: React.HTMLAttributes<HTMLDivElement>) {
  return null;
}

export function SelectPopup(_props: React.HTMLAttributes<HTMLDivElement>) {
  return null;
}

export function SelectGroup(_props: React.HTMLAttributes<HTMLDivElement>) {
  return null;
}

export function SelectGroupLabel(
  _props: React.HTMLAttributes<HTMLDivElement>,
) {
  return null;
}

export function SelectSeparator(_props: React.HTMLAttributes<HTMLDivElement>) {
  return null;
}

export function SelectItem(
  _props: React.HTMLAttributes<HTMLDivElement> & { value: string },
) {
  return null;
}

/**
 * Popover — the anchored-surface primitive for pickers that are NOT a
 * single-value list (Select already covers those). Added for the time
 * picker, whose popup holds two independent columns and so has no single
 * "selected item" for Select to own.
 *
 * Astryx-backed (#1565 PR 5): the five-part composition API is frozen
 * (barrel append-only), but behind it one `usePopover` instance — owned by
 * `PopoverRoot`, shared through context — provides anchor positioning,
 * light dismiss, Escape, and the focus trap. The surface lives in the
 * native-Popover top layer, so there is no portal and no `--z-overlay`
 * pin: the top layer paints above every z-index by definition, which is
 * how the popup outranks the Settings modal that triggers it (the bug
 * fixed for Select in WAWQAQ msg `d3ea9a33`). Focus restore on close is
 * native first: the show-popover algorithm records the previously focused
 * element even for imperative `showPopover()`, and `hidePopover()` returns
 * focus to it. Light dismiss deliberately skips that return (focus follows
 * the user's click), and Astryx's `useFocusTrap` restore effect backstops
 * whatever the browser leaves behind (its guard no-ops when focus already
 * went home — see useFocusTrap.js in @astryxdesign/core).
 *
 * Deliberate Astryx-native deviations from the Base UI predecessor, all
 * invisible to the closed-state harness: the popup gains Astryx's hidden
 * tab-past close button (localized via the AstryxLocaleProvider override
 * map, ARIA follows the Astryx primitive per #1565), and the dialog is
 * non-modal (`isModal: false`) because light dismiss never inerts the
 * background — matching the Base UI popup, which carried no aria-modal.
 *
 * Known limit, accepted: in controlled mode the trigger click still
 * toggles the real layer first and reports through onOpenChange; a parent
 * that rejects the change sees a one-frame flicker before the reconcile
 * effect restores it. Native `popover="auto"` light dismiss bypasses JS
 * entirely, so strict controlled visibility is unenforceable at this
 * primitive; the only consumer (TimePicker) accepts requests synchronously.
 */
interface PopoverContextValue {
  popover: UsePopoverReturn;
  /** PopoverPopup calls this once per open, after initial focus lands. */
  onOpenSettled(): void;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function usePopoverContext(component: string): PopoverContextValue {
  const context = React.useContext(PopoverContext);
  if (context === null) throw new Error(`${component} must be used inside <PopoverRoot>`);
  return context;
}

interface PopoverRootProps {
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Fires after the open transition settles: the popup is shown and initial focus has landed. */
  onOpenChangeComplete?: (open: boolean) => void;
  /** Accessible name for the popover dialog (Astryx `dialogLabel`). */
  label?: string;
}

export function PopoverRoot({ children, open, onOpenChange, onOpenChangeComplete, label }: PopoverRootProps): React.ReactElement {
  const callbacksRef = React.useRef({ onOpenChange, onOpenChangeComplete });
  callbacksRef.current = { onOpenChange, onOpenChangeComplete };
  // Prop-driven reconcile transitions stay silent on `onOpenChange`: the
  // parent initiated them, so echoing them back would double-report (with
  // `open` held true, Escape reports false and the reconcile show() would
  // otherwise report a spurious true). `useLayer` fires these callbacks
  // synchronously inside show()/hide(), so a flag around the calls suffices.
  // `onOpenChangeComplete` still fires — a settle is a settle no matter who
  // initiated the transition, and TimePicker keys its settled state on it.
  const reconcilingRef = React.useRef(false);
  const onShow = React.useCallback(() => {
    if (!reconcilingRef.current) callbacksRef.current.onOpenChange?.(true);
  }, []);
  const onHide = React.useCallback(() => {
    if (!reconcilingRef.current) callbacksRef.current.onOpenChange?.(false);
    callbacksRef.current.onOpenChangeComplete?.(false);
  }, []);
  // Auto-focus is owned here (not by Astryx) so `initialFocus` can land on a
  // specific element instead of the first focusable one; see PopoverPopup.
  const popover = usePopover({
    onShow,
    onHide,
    hasAutoFocus: false,
    isModal: false,
    dialogLabel: label,
  });
  // `usePopover` returns a fresh object every render, so memoizing on it is
  // pointless — but the settled callback the popup closes over MUST be
  // stable: PopoverPopup keys its focus effect on the open transition and a
  // fresh identity there would re-run it (and steal focus) on every parent
  // re-render while open.
  const onOpenSettled = React.useCallback(() => {
    callbacksRef.current.onOpenChangeComplete?.(true);
  }, []);
  const context: PopoverContextValue = { popover, onOpenSettled };

  // Controlled mode: reconcile the `open` prop with the layer state. The
  // trigger still toggles directly (and reports through onOpenChange), so a
  // matching prop round-trip lands here as a no-op.
  const { isOpen, show, hide } = popover;
  React.useEffect(() => {
    if (open === undefined) return;
    reconcilingRef.current = true;
    try {
      if (open && !isOpen) show();
      else if (!open && isOpen) hide();
    } finally {
      reconcilingRef.current = false;
    }
  }, [open, isOpen, show, hide]);

  return <PopoverContext.Provider value={context}>{children}</PopoverContext.Provider>;
}

export const PopoverTrigger = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(function PopoverTrigger(
  { onClick, onPointerDown, ...props },
  ref,
) {
  const { popover } = usePopoverContext('PopoverTrigger');
  // The trigger is an outside element to `popover="auto"`, so pressing it
  // while open light-dismisses during the press (on pointerup per the HTML
  // spec) — and the same gesture's click would then re-open. Track
  // per-gesture causality instead of a hide timestamp (Astryx's own Popover
  // uses a 50ms window, which also swallows a genuine fast re-open after
  // dismissing elsewhere). The guard judges only pointer-sourced clicks
  // (`event.detail > 0`): a keyboard activation has no paired pointerdown,
  // so a flag left behind by an aborted press (drag off, pointercancel —
  // gestures that end without a click on the trigger) must not swallow it.
  const wasOpenAtPointerDownRef = React.useRef(false);
  return (
    <button
      type="button"
      {...props}
      {...popover.triggerProps}
      ref={mergeRefs(popover.triggerRef, ref)}
      data-popup-open={popover.isOpen ? '' : undefined}
      data-slot="popover-trigger"
      onPointerDown={(event) => {
        wasOpenAtPointerDownRef.current = popover.isOpen;
        onPointerDown?.(event);
      }}
      onClick={(event) => {
        const dismissedByThisGesture =
          event.detail > 0 && wasOpenAtPointerDownRef.current && !popover.isOpen;
        wasOpenAtPointerDownRef.current = false;
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (dismissedByThisGesture) return;
        popover.toggle();
      }}
    />
  );
});

/** Layer placement is the native top layer now; this is a pass-through kept for the frozen call shape. */
export function PopoverPortal({ children }: { children?: React.ReactNode }): React.ReactElement {
  return <>{children}</>;
}

const PopoverPositionContext = React.createContext<{ alignment?: 'start' | 'center' | 'end'; sideOffset?: number }>({});

interface PopoverPositionerProps {
  children?: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  /** Gap between anchor and popup, honored as a margin on the top-layer element. */
  sideOffset?: number;
}

export function PopoverPositioner({ children, align, sideOffset }: PopoverPositionerProps): React.ReactElement {
  const value = React.useMemo(() => ({ alignment: align, sideOffset }), [align, sideOffset]);
  return <PopoverPositionContext.Provider value={value}>{children}</PopoverPositionContext.Provider>;
}

const POPOVER_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface PopoverPopupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Lands initial focus on a specific element instead of the first focusable one. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}

export function PopoverPopup({ className, initialFocus, style, children, ...props }: PopoverPopupProps): React.ReactNode {
  const { popover, onOpenSettled } = usePopoverContext('PopoverPopup');
  const { alignment, sideOffset } = React.useContext(PopoverPositionContext);
  const { isOpen, contentRef } = popover;
  // Mirror `initialFocus` through a ref so the focus effect below keys purely
  // on the open transition: initial focus is a once-per-open action, and any
  // unstable dependency would re-run it — stealing focus from whatever the
  // user clicked inside the popup — on every re-render while open.
  const initialFocusRef = React.useRef(initialFocus);
  initialFocusRef.current = initialFocus;
  React.useEffect(() => {
    if (!isOpen) return;
    // rAF: the native popover is shown synchronously, but focus waits a frame
    // so the popup has painted and scroll-into-view measures real boxes.
    const frame = requestAnimationFrame(() => {
      const target =
        initialFocusRef.current?.current ??
        contentRef.current?.querySelector<HTMLElement>(POPOVER_FOCUSABLE);
      target?.focus();
      onOpenSettled();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, contentRef, onOpenSettled]);
  return popover.render(
    // The Base UI popup carried 4px padding (`p-1`) and the positioner a 6px
    // anchor gap; both stay as inline styles — the frozen call sites rely on
    // them, and slice rules bar new Tailwind utilities in rewritten code.
    <div className={cn(className)} data-slot="popover-popup" style={{ padding: 4, ...style }} {...props}>
      {children}
    </div>,
    { placement: 'below', alignment, style: sideOffset ? { marginTop: sideOffset } : undefined },
  );
}

// =============================================================
// Field + Form
// Base UI's Field handles label / control / description / error
// association automatically via aria-describedby and aria-invalid.
// =============================================================

export const FieldRoot = BaseField.Root;
export const FieldDescription = forwardRef<HTMLParagraphElement, React.ComponentPropsWithoutRef<typeof BaseField.Description>>(function FieldDescription(
  { className, ...props },
  ref,
) {
  return <BaseField.Description ref={ref} className={cn('text-xs text-foreground-secondary', className)} data-slot="field-description" {...props} />;
});
export const Label = forwardRef<HTMLLabelElement, React.ComponentPropsWithoutRef<typeof BaseField.Label>>(function Label(
  { className, ...props },
  ref,
) {
  return <BaseField.Label ref={ref} className={cn('text-sm font-medium text-foreground', className)} data-slot="label" {...props} />;
});

// =============================================================
// Switch
// =============================================================

export const Switch = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseSwitch.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <BaseSwitch.Root
      ref={ref}
      className={cn(
        'relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full bg-foreground/16 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'data-[checked]:bg-control data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        'pointer-coarse:after:absolute pointer-coarse:after:left-1/2 pointer-coarse:after:top-1/2 pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-[" "]',
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <BaseSwitch.Thumb className="block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-background transition-transform duration-150 data-[checked]:translate-x-4 data-[checked]:bg-control-foreground" />
    </BaseSwitch.Root>
  );
});

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
// RadioGroup + Radio
// =============================================================

export const RadioGroup = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseRadioGroup>
>(function RadioGroup({ className, ...props }, ref) {
  return <BaseRadioGroup ref={ref} className={cn('grid gap-2', className)} data-slot="radio-group" {...props} />;
});

export const Radio = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseRadio.Root>
>(function Radio({ className, ...props }, ref) {
  return (
    <BaseRadio.Root
      ref={ref}
      className={cn(
        'relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-input bg-background transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20',
        'data-[checked]:border-control data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        'pointer-coarse:after:absolute pointer-coarse:after:left-1/2 pointer-coarse:after:top-1/2 pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-[" "]',
        className,
      )}
      data-slot="radio"
      {...props}
    >
      <BaseRadio.Indicator className="grid place-items-center">
        <span className="block h-2 w-2 rounded-full bg-control" />
      </BaseRadio.Indicator>
    </BaseRadio.Root>
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
