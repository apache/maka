"use client";
import * as React from "react";
import { cn } from "./cn";

// Menu：纵向导航菜单（选中态受控）

export interface MenuItemData {
  key: string;
  label: React.ReactNode;
  disabled?: boolean;
}

export function Menu({
  items,
  selectedKey,
  onSelect,
  className,
}: {
  items: MenuItemData[];
  selectedKey?: string;
  onSelect?: (key: string) => void;
  className?: string;
}) {
  return (
    <ul className={cn("space-y-1", className)}>
      {items.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            disabled={item.disabled}
            onClick={() => onSelect?.(item.key)}
            className={cn(
              "block w-full rounded-md px-3 py-2 text-left text-sm transition-colors",
              item.disabled && "cursor-not-allowed opacity-50",
              item.key === selectedKey
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
