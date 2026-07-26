import React, { forwardRef } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog';
import { Field as BaseField } from '@base-ui/react/field';
import { Progress as BaseProgress } from '@base-ui/react/progress';
import { Radio as BaseRadio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Separator as BaseSeparator } from '@base-ui/react/separator';
import { Check, ChevronDown, X } from './icons.js';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils.js';
import { inputClasses } from './primitives/input.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

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
//   Checkbox    data-[checked] / data-[disabled]
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

interface ButtonProps
  extends Omit<React.ComponentPropsWithoutRef<typeof BaseButton>, 'className'>,
    VariantProps<typeof buttonVariants> {
  className?: string;
}

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button(
  { className, variant, size, shape, ...props },
  ref,
) {
  return (
    <BaseButton
      ref={ref}
      className={cn(buttonVariants({ variant, size, shape }), className)}
      data-slot="button"
      {...props}
    />
  );
});

// #520 item 22: Input, Textarea, inputClasses, bareFieldClasses retired onto
// packages/ui/src/primitives/input.tsx + primitives/textarea.tsx (Base UI
// Input + ported chrome, single element, no span wrapper). Re-exported from
// the barrel via index.ts; number-field imports inputClasses/bareFieldClasses
// from primitives/input.js.

export const Separator = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSeparator>>(function Separator(
  { className, orientation = 'horizontal', ...props },
  ref,
) {
  return (
    <BaseSeparator
      ref={ref}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      data-slot="separator"
      {...props}
    />
  );
});

export const Checkbox = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseCheckbox.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <BaseCheckbox.Root
      ref={ref}
      className={cn(
        'relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-input bg-background text-foreground transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20',
        'data-[checked]:border-control data-[checked]:bg-control data-[checked]:text-control-foreground',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        'pointer-coarse:after:absolute pointer-coarse:after:left-1/2 pointer-coarse:after:top-1/2 pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-[" "]',
        className,
      )}
      data-slot="checkbox"
      {...props}
    >
      <BaseCheckbox.Indicator className="grid place-items-center">
        <Check size={11} aria-hidden="true" />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
});

export const DialogRoot = BaseDialog.Root;
export const DialogClose = BaseDialog.Close;
export const AlertDialogRoot = BaseAlertDialog.Root;

// Shared modal shell. Dialog and AlertDialog differ only in their Base UI
// primitive family (Root/Portal/Backdrop/Popup/Close); the layout (backdrop
// class, popup class, Portal+Backdrop+Popup+optional Close structure) is
// identical. PR6 review P3.1: kills the AlertDialogBackdrop/Popup/Content
// triple that copied Dialog's, and lets ui-tsx-design-contract's
// the bare z-index/blur utility counts return to 1.
//
// `maka-dialog-backdrop` is a stable, style-free hook so tests and the
// real-window smoke diagnostic can select the dialog backdrop; Base UI
// renders only utility classes otherwise, which drift and aren't reliably
// selectable.
const MODAL_BACKDROP_CLASS = 'maka-dialog-backdrop fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm';
const MODAL_POPUP_CLASS =
  'fixed left-1/2 top-1/2 z-50 grid max-h-[85dvh] w-[min(92vw,640px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-maka-panel';

type ModalContentProps = React.ComponentPropsWithoutRef<typeof BaseDialog.Popup> & { showClose?: boolean };
type ModalSlotPrefix = 'dialog' | 'alert-dialog';

type ModalBackdropProps = { className?: string; 'data-slot'?: string };
type ModalCloseProps = { className?: string; 'aria-label'?: string; 'data-slot'?: string; children?: React.ReactNode };

function createModalContent(primitives: {
  Portal: React.ComponentType<{ children?: React.ReactNode }>;
  Backdrop: React.ComponentType<ModalBackdropProps>;
  Popup: React.ForwardRefExoticComponent<React.ComponentPropsWithoutRef<typeof BaseDialog.Popup> & React.RefAttributes<HTMLDivElement>>;
  Close: React.ComponentType<ModalCloseProps>;
  defaultShowClose: boolean;
  slotPrefix: ModalSlotPrefix;
}) {
  return forwardRef<HTMLDivElement, ModalContentProps>(function ModalContent(
    { className, children, showClose = primitives.defaultShowClose, ...props },
    ref,
  ) {
    const copy = getSharedUiCopy(useUiLocale()).primitives;
    const { Portal, Backdrop, Popup, Close, slotPrefix } = primitives;
    return (
      <Portal>
        <Backdrop className={MODAL_BACKDROP_CLASS} data-slot={`${slotPrefix}-backdrop`} />
        <Popup ref={ref} className={cn(MODAL_POPUP_CLASS, className)} data-slot={`${slotPrefix}-popup`} {...props}>
          {showClose && (
            <Close
              className={cn(buttonVariants({ variant: 'quiet', size: 'icon-sm' }), 'absolute right-3 top-3')}
              aria-label={copy.close}
              data-slot={`${slotPrefix}-close`}
            >
              <X aria-hidden="true" />
            </Close>
          )}
          {children}
        </Popup>
      </Portal>
    );
  });
}

export const DialogContent = createModalContent({
  Portal: BaseDialog.Portal,
  Backdrop: BaseDialog.Backdrop,
  Popup: BaseDialog.Popup,
  Close: BaseDialog.Close,
  defaultShowClose: true,
  slotPrefix: 'dialog',
});

// AlertDialog — the alert variant locks modal + disables pointer dismissal,
// so confirmation dialogs require an explicit decision. Escape is NOT
// auto-disabled (Base UI alert-dialog still closes on Esc); callers that must
// not be Esc-dismissed intercept onOpenChange and cancel. PR6 (#520).
export const AlertDialogContent = createModalContent({
  Portal: BaseAlertDialog.Portal,
  Backdrop: BaseAlertDialog.Backdrop,
  Popup: BaseAlertDialog.Popup,
  Close: BaseAlertDialog.Close,
  defaultShowClose: false,
  slotPrefix: 'alert-dialog',
});

// Tabs: re-export the shared tab spec primitive (#499 P0-3). The tab spec
// (maka-tab class + underline/pill variants + neutral state tokens) lives in
// primitives/tabs.tsx. ui.tsx used to carry a second hand-rolled set (Base UI
// + bg-muted plate, no variant, dead data-[selected] active selectors — Base
// UI sets data-active) which plan-reminder-panel consumed, bypassing the spec.
// Re-exporting unifies on one primitive so every tab surface gets variant +
// maka-tab + the correct data-active attribute.
export { Tabs as TabsRoot, TabsList, TabsTab as TabsTrigger, TabsPanel } from './primitives/tabs.js';

export const SelectRoot = BaseSelect.Root;
export const SelectTrigger = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger> & { appearance?: PickerTriggerAppearance }
>(function SelectTrigger(
  { appearance = 'field', className, children, ...props },
  ref,
) {
  return (
    <BaseSelect.Trigger
      ref={ref}
      className={cn(pickerTriggerClasses(appearance), 'justify-between', className)}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <BaseSelect.Icon>
        <ChevronDown size={14} aria-hidden="true" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
});

export const SelectValue = BaseSelect.Value;
export const SelectPortal = BaseSelect.Portal;
/**
 * The overlay layer belongs on the POSITIONER, not the popup.
 *
 * Base UI renders the popup `position: static` inside an absolutely
 * positioned positioner. `z-index` has no effect on a static box, so the
 * layer that used to sit on `SelectPopup` was inert; what actually kept
 * settings selects above the modal was `.settingsSelectPositioner`
 * (styles/settings/select.css), applied by hand at each call site. Any
 * call site that forgot it portalled a popup that paints *below* the
 * `.settingsModal` layer — invisible, and unclickable because the modal
 * wins the hit-test. Settings → 通用 → 默认权限模式 shipped that way and
 * read as "clicking does nothing at all".
 *
 * Carrying the layer here makes it structural: every Select consumer
 * gets it by construction instead of by remembering a class name.
 */
export const SelectPositioner = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Positioner>>(function SelectPositioner(
  { className, ...props },
  ref,
) {
  return <BaseSelect.Positioner ref={ref} className={cn('z-[var(--z-overlay)]', className)} data-slot="select-positioner" {...props} />;
});
export const SelectPopup = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Popup>>(function SelectPopup(
  { className, ...props },
  ref,
) {
  return <BaseSelect.Popup ref={ref} className={cn('min-w-40 rounded-md bg-popover p-1 text-popover-foreground shadow-maka-panel', className)} data-slot="select-popup" {...props} />;
});
export const SelectGroup = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Group>>(function SelectGroup(
  { className, ...props },
  ref,
) {
  return <BaseSelect.Group ref={ref} className={cn('py-1', className)} data-slot="select-group" {...props} />;
});
export const SelectGroupLabel = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.GroupLabel>>(function SelectGroupLabel(
  { className, ...props },
  ref,
) {
  return <BaseSelect.GroupLabel ref={ref} className={cn('px-2 py-1 text-xs font-medium text-foreground-secondary', className)} data-slot="select-group-label" {...props} />;
});
export const SelectSeparator = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Separator>>(function SelectSeparator(
  { className, ...props },
  ref,
) {
  return <BaseSelect.Separator ref={ref} className={cn('my-1 h-px bg-border', className)} data-slot="select-separator" {...props} />;
});

export const SelectItem = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Item>>(function SelectItem(
  { className, children, ...props },
  ref,
) {
  return (
    <BaseSelect.Item
      ref={ref}
      className={cn('grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[selected]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)}
      data-slot="select-item"
      {...props}
    >
      <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
        <BaseSelect.ItemIndicator>
          <Check size={13} aria-hidden="true" />
        </BaseSelect.ItemIndicator>
      </span>
      <span className="min-w-0">
        <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
      </span>
    </BaseSelect.Item>
  );
});

/**
 * Popover — the anchored-surface primitive for pickers that are NOT a
 * single-value list (Select already covers those). Added for the time
 * picker, whose popup holds two independent columns and so has no single
 * "selected item" for Select to own.
 *
 * The popup pins the same `--z-overlay` layer as `SelectPopup`: the
 * Settings modal sits on its own layer, and a bare Tailwind z-utility
 * would render the popup *beneath* the modal that triggered it — the bug
 * fixed for Select in WAWQAQ msg `d3ea9a33`.
 */
export const PopoverRoot = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;
export const PopoverPortal = BasePopover.Portal;
/** Carries the overlay layer for the same reason `SelectPositioner` does —
 *  the popup below is `position: static`, so a z-index there is inert. */
export const PopoverPositioner = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BasePopover.Positioner>>(function PopoverPositioner(
  { className, ...props },
  ref,
) {
  return <BasePopover.Positioner ref={ref} className={cn('z-[var(--z-overlay)]', className)} data-slot="popover-positioner" {...props} />;
});
export const PopoverPopup = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BasePopover.Popup>>(function PopoverPopup(
  { className, ...props },
  ref,
) {
  return (
    <BasePopover.Popup
      ref={ref}
      className={cn('rounded-md bg-popover p-1 text-popover-foreground shadow-maka-panel outline-none', className)}
      data-slot="popover-popup"
      {...props}
    />
  );
});

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
