"use client";
import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { X } from "lucide-react";
import { cn } from "./cn";
import { buttonVariants } from "./button";

// Drawer：Dialog 的侧滑形态（ant-design Drawer）

export const Drawer = AlertDialogPrimitive.Root;
export const DrawerTrigger = AlertDialogPrimitive.Trigger;
export const DrawerClose = AlertDialogPrimitive.Cancel;

export function DrawerContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & { side?: "right" | "left" | "bottom" }) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <AlertDialogPrimitive.Content
        className={cn(
          "fixed z-50 gap-4 bg-background p-6 shadow-lg transition",
          side === "right" && "inset-y-0 right-0 h-full w-3/4 max-w-sm data-[state=open]:animate-in data-[state=open]:slide-in-from-right",
          side === "left" && "inset-y-0 left-0 h-full w-3/4 max-w-sm data-[state=open]:animate-in data-[state=open]:slide-in-from-left",
          side === "bottom" && "inset-x-0 bottom-0 max-h-[80vh] data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom",
          className,
        )}
        {...props}
      >
        {children}
        <AlertDialogPrimitive.Cancel className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
          <X className="size-4" />
        </AlertDialogPrimitive.Cancel>
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}

export function DrawerHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4 flex flex-col gap-1.5", className)} {...props} />;
}

export function DrawerTitle({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return <AlertDialogPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />;
}

export function DrawerDescription({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return <AlertDialogPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function DrawerFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-4 flex justify-end gap-2", className)} {...props} />;
}

export { buttonVariants };
