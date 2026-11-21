"use client";
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "./cn";

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn("peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb className={cn("pointer-events-none block size-4 rounded-full bg-background shadow-lg transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0")} />
    </SwitchPrimitive.Root>
  );
}
