import type { ReactNode } from 'react';
import type { AutomationModule, ExtensionModule } from './nav-selection.js';
import { useUiLocale } from './locale-context.js';
import { Blocks, CalendarCheck, ChevronDown, Plug, Sun } from './icons.js';
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from './primitives/menu.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { Button } from './ui.js';

export type ModuleHubHeader = {
  title: string;
  subtitle?: string;
  badge: ReactNode;
};

type ModuleHubSelectorProps =
  | {
      hub: 'extensions';
      value: ExtensionModule;
      onChange(value: ExtensionModule): void;
    }
  | {
      hub: 'automations';
      value: AutomationModule;
      onChange(value: AutomationModule): void;
    };

type SelectorOption = readonly [value: string, label: string, icon: ReactNode];

function Selector(props: {
  value: string;
  options: readonly SelectorOption[];
  ariaLabel: string;
  onChange(value: string): void;
}) {
  const selected = props.options.find(([value]) => value === props.value) ?? props.options[0];
  if (!selected) return null;

  return (
    <span className="maka-module-hub-selector">
      <span className="maka-module-hub-separator" aria-hidden="true">/</span>
      <Menu>
        <MenuTrigger
          render={<Button variant="quiet" />}
          className="maka-module-hub-selector-trigger"
          aria-label={props.ariaLabel}
        >
          {selected[2]}
          <span>{selected[1]}</span>
          <ChevronDown className="maka-module-hub-selector-chevron" size={15} aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup className="maka-module-hub-selector-menu" align="start" sideOffset={6}>
          <MenuRadioGroup value={props.value} onValueChange={props.onChange}>
            {props.options.map(([value, label, icon]) => (
              <MenuRadioItem key={value} value={value}>
                <span className="maka-module-hub-selector-option">
                  {icon}
                  <span>{label}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </span>
  );
}

export function ModuleHubSelector(props: ModuleHubSelectorProps) {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs;
  if (props.hub === 'extensions') {
    const options = [
      ['skills', copy.extensions.skills, <Blocks key="skills" size={16} aria-hidden="true" />],
      ['mcp', copy.extensions.mcp, <Plug key="mcp" size={16} aria-hidden="true" />],
    ] as const;
    const selectedLabel = options.find(([value]) => value === props.value)?.[1] ?? copy.extensions.skills;
    return (
      <Selector
        value={props.value}
        options={options}
        ariaLabel={copy.extensions.selectorLabel(selectedLabel)}
        onChange={(value) => props.onChange(value as ExtensionModule)}
      />
    );
  }

  const options = [
    ['plan-reminders', copy.automations.planReminders, <CalendarCheck key="plan-reminders" size={16} aria-hidden="true" />],
    ['daily-review', copy.automations.dailyReview, <Sun key="daily-review" size={16} aria-hidden="true" />],
  ] as const;
  const selectedLabel = options.find(([value]) => value === props.value)?.[1] ?? copy.automations.planReminders;
  return (
    <Selector
      value={props.value}
      options={options}
      ariaLabel={copy.automations.selectorLabel(selectedLabel)}
      onChange={(value) => props.onChange(value as AutomationModule)}
    />
  );
}
