'use client';

import { AppSidebar } from "@ggbdpq/console-ui";
import {
  Clapperboard,
  Code2,
  FileText,
  Rss,  Sprout,
  User,
  Users,
} from "lucide-react";

const navItems = [
  { href: "/", label: "朋友圈", icon: Users },
  { href: "/articles", label: "文章", icon: FileText },
  { href: "/algo", label: "算法", icon: Code2 },
  { href: "/growth", label: "成长", icon: Sprout },
  { href: "/anime", label: "动漫", icon: Clapperboard },
  { href: "/about", label: "关于", icon: User },
  { href: "/rss.xml", label: "RSS 订阅", icon: Rss },
];

// 博客侧栏：icon 引用不能从 Server Component 传入，导航表留在客户端。
export function BlogSidebar() {
  return (
    <AppSidebar
      title="ggbdpq"
      storageKey="blog-sidebar-collapsed"
      items={navItems}
    />
  );
}
