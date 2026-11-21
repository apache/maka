'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';

export type ModuleNavItem = {
  to: string;
  label: string;
  icon?: LucideIcon;
  exact?: boolean;
};

// 模块顶栏页签，全站统一外壳。GitHub UnderlineNav 式：激活项 2px 底线（橙 nav-accent）
// 贴住容器分隔线，无圆角填充。
export function ModuleNav({ items, className }: { items: ModuleNavItem[]; className?: string }) {
  const pathname = usePathname();
  return (
    <nav className={cn('flex flex-wrap gap-1 border-b', className)}>
      {items.map(({ to, label, icon: Icon, exact }) => {
        const active = exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
        return (
          <Link
            key={to}
            href={to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-nav-accent font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon ? <Icon className="size-4" /> : null}
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
