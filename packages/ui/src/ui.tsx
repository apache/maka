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

// Toast and destructive confirmation are owned by Astryx in
// `packages/ui/src/toast.tsx`, exposed through the project's `useToast()` /
// `toast.confirm()` product API.
