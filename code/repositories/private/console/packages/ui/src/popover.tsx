"use client";
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "./cn";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({ className, align = "center", sideOffset = 4, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn("z-50 w-72 rounded-lg border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
