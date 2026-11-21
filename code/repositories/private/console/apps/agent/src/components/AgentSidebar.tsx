'use client';

import { AppSidebar } from "@ggbdpq/console-ui";
import {
  BookOpenText,
  FlaskConical,
  GitBranch,
  GraduationCap,
  LayoutDashboard,
  Presentation,
  ScanSearch,
  Settings,
  ShieldCheck,
  Workflow,
  Download,
  MessagesSquare,
} from "lucide-react";

const navItems = [
  { href: "/", label: "总览", icon: LayoutDashboard },
  { href: "/agentops", label: "配置台", icon: Settings },
  { href: "/governance", label: "治理台", icon: ShieldCheck },
  { href: "/lab", label: "实验室", icon: FlaskConical },
  { href: "/workflow", label: "执行引擎", icon: Workflow },
  { href: "/worktree", label: "Worktree 台", icon: GitBranch },
  { href: "/course", label: "课程", icon: GraduationCap },
  { href: "/deck", label: "幻灯片", icon: Presentation },
  { href: "/interview-gym", label: "面试自练场", icon: BookOpenText },
  { href: "/diffmap", label: "变更审查", icon: ScanSearch },
  { href: "/ruoyi-ai", label: "RuoYi AI 知识库", icon: MessagesSquare },
  { href: "/downloads", label: "下载台", icon: Download },
];

// AI Agent 线全局导航侧栏：壳与收起逻辑统一在 @ggbdpq/console-ui 的 AppSidebar。
export function AgentSidebar() {
  return (
    <AppSidebar
      title="Agent"
      storageKey="agent-sidebar-collapsed"
      items={navItems}
    />
  );
}
