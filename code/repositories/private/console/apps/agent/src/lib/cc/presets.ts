/**
 * 内置预设定义
 */

export interface Preset {
  id: string;
  name: string;
  icon: string;
  description: string;
  enabledPlugins: Record<string, boolean>;
  builtin: boolean;
}

/**
 * 内置预设列表
 */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: "learn",
    name: "学习模式",
    icon: "📚",
    description: "Token 优化 -30%~40%，适合学习和理解代码",
    builtin: true,
    enabledPlugins: {
      "learning-output-style@claude-plugins-official": true,
      "explanatory-output-style@claude-plugins-official": true,
      "context7@claude-plugins-official": true,
      "hookify@claude-plugins-official": true,
      "code-review@claude-plugins-official": false,
      "code-simplifier@claude-plugins-official": false,
      "feature-dev@claude-plugins-official": false,
      "frontend-design@claude-plugins-official": false,
    },
  },
  {
    id: "frontend-dev",
    name: "前端开发",
    icon: "⚛️",
    description: "React/Vue/Angular 专用配置",
    builtin: true,
    enabledPlugins: {
      "code-review@claude-plugins-official": true,
      "code-simplifier@claude-plugins-official": true,
      "frontend-design@claude-plugins-official": true,
      "feature-dev@claude-plugins-official": true,
      "commit-commands@claude-plugins-official": true,
      "learning-output-style@claude-plugins-official": false,
      "explanatory-output-style@claude-plugins-official": false,
    },
  },
  {
    id: "plan",
    name: "规划模式",
    icon: "📋",
    description: "Token 优化 -50%~60%，专注架构和规划",
    builtin: true,
    enabledPlugins: {
      "hookify@claude-plugins-official": true,
      "code-review@claude-plugins-official": false,
      "code-simplifier@claude-plugins-official": false,
      "frontend-design@claude-plugins-official": false,
      "feature-dev@claude-plugins-official": false,
      "commit-commands@claude-plugins-official": false,
    },
  },
  {
    id: "ops",
    name: "运维部署",
    icon: "🚀",
    description: "CI/CD 和部署专用配置",
    builtin: true,
    enabledPlugins: {
      "github@claude-plugins-official": true,
      "vercel@claude-plugins-official": true,
      "commit-commands@claude-plugins-official": true,
      "code-review@claude-plugins-official": false,
      "frontend-design@claude-plugins-official": false,
    },
  },
  {
    id: "research",
    name: "技术调研",
    icon: "🔍",
    description: "文档查询和知识整理",
    builtin: true,
    enabledPlugins: {
      "context7@claude-plugins-official": true,
      "learning-output-style@claude-plugins-official": true,
      "explanatory-output-style@claude-plugins-official": true,
      "code-review@claude-plugins-official": false,
      "feature-dev@claude-plugins-official": false,
    },
  },
];

/**
 * 根据 ID 获取内置预设
 */
export function getBuiltinPreset(id: string): Preset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}
