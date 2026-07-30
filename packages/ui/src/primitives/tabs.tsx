'use client';

import {
  Tab as AstryxTab,
  TabList as AstryxTabList,
  type TabListProps as AstryxTabListProps,
} from '@astryxdesign/core/TabList';
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';

export type TabsVariant = 'default' | 'underline' | 'pill';

type TabsContextValue = {
  value: string;
  onChange: (value: string) => void;
  orientation: 'horizontal' | 'vertical';
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error('Tabs components must be rendered inside Tabs');
  return context;
}

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'horizontal' | 'vertical';
}

/**
 * Owns only Maka's active panel value. Astryx TabList owns tab navigation,
 * focus movement, selection affordances, and accessibility semantics.
 */
export function Tabs({
  value: controlledValue,
  defaultValue = '',
  onValueChange,
  orientation = 'horizontal',
  children,
  ...props
}: TabsProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const value = controlledValue ?? uncontrolledValue;
  const context = useMemo<TabsContextValue>(
    () => ({
      value,
      orientation,
      onChange: (nextValue) => {
        if (controlledValue === undefined) setUncontrolledValue(nextValue);
        onValueChange?.(nextValue);
      },
    }),
    [controlledValue, onValueChange, orientation, value],
  );

  return (
    <TabsContext value={context}>
      <div {...props} data-slot="tabs" data-orientation={orientation}>
        {children}
      </div>
    </TabsContext>
  );
}

export interface TabsListProps
  extends Omit<AstryxTabListProps, 'value' | 'onChange' | 'orientation'> {
  variant?: TabsVariant;
}

export function TabsList({
  variant = 'default',
  hasDivider,
  ...props
}: TabsListProps) {
  const tabs = useTabsContext();
  return (
    <AstryxTabList
      {...props}
      value={tabs.value}
      onChange={tabs.onChange}
      orientation={tabs.orientation}
      hasDivider={hasDivider ?? variant === 'underline'}
      data-slot="tabs-list"
      data-variant={variant}
    />
  );
}

export const TabsTab = AstryxTab;

export interface TabsPanelProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  keepMounted?: boolean;
}

export function TabsPanel({
  value,
  keepMounted = false,
  children,
  ...props
}: TabsPanelProps) {
  const tabs = useTabsContext();
  const isActive = tabs.value === value;
  if (!isActive && !keepMounted) return null;

  return (
    <div {...props} data-slot="tabs-content" hidden={!isActive}>
      {children}
    </div>
  );
}

export const TabsPrimitive = {
  Root: Tabs,
  List: TabsList,
  Tab: TabsTab,
  Panel: TabsPanel,
};

export { TabsTab as TabsTrigger, TabsPanel as TabsContent };
