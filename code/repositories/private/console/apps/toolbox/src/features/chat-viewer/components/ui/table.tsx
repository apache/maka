import * as React from "react";

import { cn } from "@/features/chat-viewer/lib/utils";

/**
 * 带横向滚动容器的基础表格组件。
 */
export function Table({
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-auto">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

/**
 * 表格头部区域。
 */
export function TableHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-zinc-200 dark:border-zinc-800", className)} {...props} />;
}

/**
 * 表格主体区域。
 */
export function TableBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

/**
 * 表格行组件。
 */
export function TableRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn("border-b border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/60", className)}
      {...props}
    />
  );
}

/**
 * 表头单元格组件。
 */
export function TableHead({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("h-10 px-4 text-left align-middle text-xs font-medium text-zinc-500 dark:text-zinc-400", className)}
      {...props}
    />
  );
}

/**
 * 表格内容单元格组件。
 */
export function TableCell({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 align-middle", className)} {...props} />;
}
