"use client";
import * as React from "react";
import { cn } from "./cn";
import { Label } from "./label";

// Form：布局组合层（校验逻辑由调用方用 zod 承担，这里只管结构）

export function Form({ className, ...props }: React.ComponentProps<"form">) {
  return <form className={cn("space-y-4", className)} {...props} />;
}

export function FormField({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("space-y-1.5", className)} {...props} />;
}

export function FormLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return <Label className={cn("text-sm font-medium", className)} {...props} />;
}

export function FormControl({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("", className)} {...props} />;
}

export function FormDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function FormError({ className, children, ...props }: React.ComponentProps<"p">) {
  if (!children) return null;
  return (
    <p className={cn("text-xs text-destructive", className)} {...props}>
      {children}
    </p>
  );
}
