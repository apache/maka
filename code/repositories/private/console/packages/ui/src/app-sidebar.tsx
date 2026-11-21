"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "./cn";
import { ThemeToggle } from "./theme-toggle";

export interface AppSidebarItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// 通用应用侧栏（左菜单 + 右内容壳的左半边）：支持收起（图标态），
// 收起状态按 storageKey 持久化到 localStorage，各 app 传入自己的导航项。
export function AppSidebar({
  title,
  items,
  storageKey,
}: {
  title: ReactNode;
  items: AppSidebarItem[];
  storageKey: string;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // SSR 首帧按展开渲染，挂载后恢复用户偏好
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(storageKey) === "1");
    } catch {}
  }, [storageKey]);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r bg-muted/40 transition-all",
        collapsed ? "w-14" : "w-56",
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center justify-between border-b px-3 font-semibold",
          collapsed && "flex-col justify-center gap-2 px-0",
        )}
      >
        {collapsed ? (
          <>
            <button
              onClick={toggle}
              title="展开菜单"
              aria-label="展开菜单"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <ThemeToggle />
          </>
        ) : (
          <>
            {title}
            <div className="flex items-center gap-1">
              <button
                onClick={toggle}
                title="收起菜单"
                aria-label="收起菜单"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <ThemeToggle />
            </div>
          </>
        )}
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {items.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                collapsed && "justify-center px-0",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="ml-3">{label}</span>}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
