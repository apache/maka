import React, { forwardRef } from 'react';
import { Progress as BaseProgress } from '@base-ui/react/progress';
import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';
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

// #1565 PR 4: TextInput, TextArea, NumberInput, Switch, and CheckboxInput are
// Astryx-owned. This legacy class recipe remains only for picker triggers.

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

// Toast and destructive confirmation are owned by Astryx in
// `packages/ui/src/toast.tsx`, exposed through the project's `useToast()` /
// `toast.confirm()` product API.
