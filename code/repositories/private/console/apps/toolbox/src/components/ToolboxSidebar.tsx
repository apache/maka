'use client';

import { AppSidebar } from "@ggbdpq/console-ui";
import {
  ArrowLeft,
  Component,
  Database,
  FileText,
  Heart,
  LayoutGrid,
  MessageCircle,
  MessagesSquare,
  Newspaper,
  Presentation,
} from "lucide-react";

const navItems = [
  { href: "/", label: "总览", icon: LayoutGrid },
  { href: "/forum", label: "论坛", icon: MessagesSquare },
  { href: "/admin", label: "演示后台", icon: Presentation },
  { href: "/resume", label: "简历管理", icon: FileText },
  { href: "/date-playbook", label: "约会攻略", icon: Heart },
  { href: "/chat-viewer", label: "聊天查看器", icon: MessageCircle },
  { href: "/daily", label: "AI 日报", icon: Newspaper },
  { href: "/database", label: "数据库对比", icon: Database },
  { href: "/ui", label: "组件陈列室", icon: Component },
  { href: "http://localhost:65502", label: "返回博客", icon: ArrowLeft },
];

// 工具箱侧栏：icon 引用不能从 Server Component 传入，导航表留在客户端。
export function ToolboxSidebar() {
  return (
    <AppSidebar
      title="工具箱"
      storageKey="toolbox-sidebar-collapsed"
      items={navItems}
    />
  );
}
