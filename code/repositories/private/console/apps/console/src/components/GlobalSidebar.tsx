'use client';

import { AppSidebar } from "@ggbdpq/console-ui";
import {
  Bookmark,
  Boxes,
  Database,
  History,
  LayoutDashboard,
  ListTodo,
  UserPlus,
  Users,
} from "lucide-react";

const navItems = [
  { href: "/", label: "总览", icon: LayoutDashboard },
  { href: "/assets", label: "资产台", icon: Boxes },
  { href: "/inventory", label: "库存台", icon: Database },
  { href: "/register", label: "注册台", icon: UserPlus },
  { href: "/toolkit", label: "工具集", icon: Users },
  { href: "/todo", label: "清单台", icon: ListTodo },
  { href: "/bookmarks", label: "书签台", icon: Bookmark },
  { href: "/practice", label: "实践台", icon: History },
];

// 全局导航侧栏：壳与收起逻辑统一在 @ggbdpq/console-ui 的 AppSidebar。
export function GlobalSidebar() {
  return (
    <AppSidebar
      title="Console"
      storageKey="console-sidebar-collapsed"
      items={navItems}
    />
  );
}
