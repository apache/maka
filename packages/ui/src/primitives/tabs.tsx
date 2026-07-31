"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "../utils.js";
import type React from "react";

export type TabsVariant = "default" | "underline" | "pill";

export function Tabs({
  className,
  ...props
}: TabsPrimitive.Root.Props): React.ReactElement {
  return (
    <TabsPrimitive.Root
      className={cn(
        "flex flex-col gap-2 data-[orientation=vertical]:flex-row",
        className,
      )}
      data-slot="tabs"
      {...props}
    />
  );
}

export function TabsList({
  variant = "default",
  className,
  children,
  ...props
}: TabsPrimitive.List.Props & {
  variant?: TabsVariant;
}): React.ReactElement {
  return (
    <TabsPrimitive.List
      className={cn(
        "maka-tabs-list relative z-0 flex w-fit items-center justify-center gap-x-0.5 text-foreground-secondary",
        "data-[orientation=vertical]:flex-col",
        variant === "default"
          ? "rounded-md bg-muted p-0.5 text-foreground-secondary/72"
          : "data-[orientation=vertical]:px-1 data-[orientation=horizontal]:py-1",
        className,
      )}
      data-slot="tabs-list"
      data-variant={variant}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        className={cn(
          "absolute bottom-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) -translate-y-(--active-tab-bottom) transition-[width,translate] duration-[var(--duration-base)] ease-[var(--ease-in-out-strong)]",
          variant === "underline"
            ? "z-10 bg-foreground data-[orientation=horizontal]:h-0.5 data-[orientation=vertical]:w-0.5 data-[orientation=vertical]:-translate-x-px data-[orientation=horizontal]:translate-y-px"
            : variant === "pill"
              ? "hidden"
              : "-z-1 rounded-md bg-background shadow-sm/5 dark:bg-input",
        )}
        data-slot="tab-indicator"
      />
    </TabsPrimitive.List>
  );
}

export function TabsTab({
  className,
  ...props
}: TabsPrimitive.Tab.Props): React.ReactElement {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "maka-tab relative flex h-9 shrink-0 grow cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent px-[calc(--spacing(2.5)-1px)] font-medium text-base outline-none transition-[color,background-color,box-shadow] hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start data-active:text-foreground data-disabled:opacity-64 sm:h-8 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
        className,
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

export function TabsPanel({
  className,
  ...props
}: TabsPrimitive.Panel.Props): React.ReactElement {
  return (
    <TabsPrimitive.Panel
      className={cn("flex-1 outline-none", className)}
      data-slot="tabs-content"
      {...props}
    />
  );
}

export { TabsPrimitive, TabsTab as TabsTrigger, TabsPanel as TabsContent };
