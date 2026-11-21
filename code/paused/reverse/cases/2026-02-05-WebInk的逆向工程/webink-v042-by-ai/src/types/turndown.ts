// src/types/turndown.ts
// ========================================
// Turndown 库相关类型定义
// ========================================

/**
 * Turndown 服务接口
 */
export interface TurndownService {
  /** 转换 HTML 为 Markdown */
  convert(html: string): string;

  /** 添加规则 */
  addRule(key: string, rule: TurndownRule): this;

  /** 使用插件 */
  use(extension: TurndownExtension): this;

  /** 设置选项 */
  setOptions(options: TurndownOptions): this;
}

/**
 * Turndown 选项
 */
export interface TurndownOptions {
  /** 标题样式 */
  headingStyle?: 'setext' | 'atx';

  /** 水平线样式 */
  hr?: string;

  /** 列表缩进 */
  bulletListMarker?: '-' | '*' | '+';

  /** 代码块样式 */
  codeBlockStyle?: 'fenced' | 'indented';

  /** 围栏代码块语言 */
  fence?: string | null;

  /** 强调符号 */
  emDelimiter?: '_' | '*';

  /** 粗体符号 */
  strongDelimiter?: '__' | '**';

  /** 链接样式 */
  linkStyle?: 'inlined' | 'referenced';

  /** 链接引用 */
  linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut';

  /** 删除线 */
  strikethrough?: boolean;

  /** 任务列表 */
  taskListItems?: boolean;
}

/**
 * Turndown 规则
 */
export interface TurndownRule {
  /** 过滤器函数 */
  filter: string | Node[] | ((node: Node) => boolean);

  /** 替换函数 */
  replacement: (content: string, node: Node, options: TurndownOptions) => string;
}

/**
 * Turndown 插件
 */
export interface TurndownExtension {
  (turndownService: TurndownService): void;
}

/**
 * GFM (GitHub Flavored Markdown) 选项
 */
export interface GFMOptions {
  /** 表格支持 */
  tables?: boolean;

  /** 任务列表 */
  taskListItems?: boolean;

  /** 删除线 */
  strikethrough?: boolean;

  /** 自动链接 */
  autolink?: boolean;
}

/**
 * 语法高亮选项
 */
export interface HighlightCodeBlock {
  /** 代码块内容 */
  code: string;

  /** 语言 */
  language?: string;

  /** 是否高亮 */
  highlighted?: boolean;
}
