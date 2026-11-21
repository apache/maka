import * as React from "react";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "./cn";

export function Breadcrumb({ className, ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="breadcrumb" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return <ol className={cn("flex flex-wrap items-center gap-1.5", className)} {...props} />;
}

export function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li className={cn("inline-flex items-center gap-1.5", className)} {...props} />;
}

export function BreadcrumbLink({ className, ...props }: React.ComponentProps<"a">) {
  return <a className={cn("transition-colors hover:text-foreground", className)} {...props} />;
}

export function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("font-medium text-foreground", className)} {...props} />;
}

export function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<"li">) {
  return (
    <li role="presentation" className={cn("[&>svg]:size-3.5", className)} {...props}>
      {children ?? <ChevronRight />}
    </li>
  );
}

export function BreadcrumbEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span className={cn("flex size-5 items-center justify-center", className)} {...props}>
      <MoreHorizontal className="size-4" />
    </span>
  );
}
