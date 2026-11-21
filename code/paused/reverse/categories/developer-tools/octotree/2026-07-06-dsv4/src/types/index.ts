// ============================================================
// Octotree v8.3.0 — TypeScript 类型定义（逆向工程，dsv4）
// 基于 manifest.json 与 background.js/content.js 源码分析还原
// ============================================================

// ---------------------------------------------------------------------------
// 存储键（chrome.storage.local）
// ---------------------------------------------------------------------------

/** chrome.storage.local 使用的已知存储键 */
export const STORAGE_KEYS = {
  /** Octotree 访问令牌（GitHub Personal Access Token） */
  ACCESS_TOKEN: 'octotree_access_token',
  /** 用户偏好设置 */
  SETTINGS: 'octotree_settings',
  /** 用户会话数据 */
  SESSION: 'octotree_session',
  /** 订阅/许可证信息 */
  LICENSE: 'octotree_license',
} as const;

// ---------------------------------------------------------------------------
// 用户设置
// ---------------------------------------------------------------------------

/** 主题枚举 */
export type ThemeName =
  | 'default'
  | 'dark'
  | 'light';

/** 侧边栏停靠位置 */
export type SidebarDockPosition =
  | 'left'
  | 'right';

/** 字体族枚举 */
export type FontFamily =
  | 'default'
  | 'cascadia-code'
  | 'iosevka'
  | 'fira-code'
  | 'inconsolata'
  | 'recursive-mono'
  | 'source-code-pro'
  | 'space-mono'
  | 'ubuntu-mono'
  | 'jetbrains-mono'
  | 'anonymous-pro'
  | 'victor-mono';

/** 文件图标主题 */
export type IconTheme =
  | 'vscode'
  | 'vscodemat'
  | 'default';

/** 用户偏好设置 */
export interface OctotreeSettings {
  /** 侧边栏停靠位置 */
  dockPosition: SidebarDockPosition;
  /** 侧边栏宽度（px） */
  sidebarWidth: number;
  /** 主题名称 */
  theme: ThemeName;
  /** 字体族 */
  fontFamily: FontFamily;
  /** 字体大小 */
  fontSize: number;
  /** 文件图标主题 */
  iconTheme: IconTheme;
  /** 是否显示文件图标 */
  showFileIcons: boolean;
  /** 是否显示文件夹图标 */
  showFolderIcons: boolean;
  /** 是否自动折叠子目录 */
  autoCollapse: boolean;
  /** 默认是否展开 */
  expanded: boolean;
  /** 是否显示行号 */
  showLineNumbers: boolean;
  /** 是否启用代码高亮 */
  codeHighlight: boolean;
  /** PR 文件树 */
  prFileTree: boolean;
  /** 是否加载字体 */
  loadFonts: boolean;
  /** 是否隐藏空目录 */
  hideEmptyDirectories: boolean;
  /** 懒加载深度 */
  lazyLoadDepth: number;
}

/** 默认设置 */
export const DEFAULT_SETTINGS: OctotreeSettings = {
  dockPosition: 'left',
  sidebarWidth: 320,
  theme: 'default',
  fontFamily: 'default',
  fontSize: 13,
  iconTheme: 'vscode',
  showFileIcons: true,
  showFolderIcons: true,
  autoCollapse: false,
  expanded: false,
  showLineNumbers: true,
  codeHighlight: true,
  prFileTree: true,
  loadFonts: true,
  hideEmptyDirectories: false,
  lazyLoadDepth: 1,
};

// ---------------------------------------------------------------------------
// 订阅/许可证
// ---------------------------------------------------------------------------

/** 许可证/订阅状态 */
export type LicenseTier =
  | 'free'
  | 'pro'
  | 'team'
  | 'enterprise';

/** 许可证信息 */
export interface LicenseInfo {
  /** 许可证层级 */
  tier: LicenseTier;
  /** 是否有效 */
  valid: boolean;
  /** 过期时间（ISO 8601） */
  expiresAt: string | null;
  /** 关联的 GitHub 用户 */
  githubUser: string | null;
}

// ---------------------------------------------------------------------------
// 消息通信
// ---------------------------------------------------------------------------

/** Content -> Background 的 API 代理请求消息 */
export interface OctotreeApiRequest {
  eventName: 'octotree_send_request';
  /** HTTP 方法 */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** API 路径（相对于 https://www.octotree.io/api/v1.0/） */
  path: string;
  /** 请求体（JSON 字符串） */
  body: string | null;
  /** GitHub Personal Access Token (可选) */
  token: string | null;
}

/** Background -> Content 的 API 代理响应 */
export interface OctotreeApiResponse {
  /** 响应体（已解析的 JSON 或纯文本） */
  responseBody?: unknown;
  /** HTTP 状态码 */
  responseStatus?: number;
  /** 错误信息 */
  message?: string;
  /** 错误状态码 */
  statusCode?: number;
  /** 限流重试时间（秒） */
  retryAfter?: number;
}

// ---------------------------------------------------------------------------
// GitHub API 数据模型（由 Octotree 调用）
// ---------------------------------------------------------------------------

/** GitHub 仓库元数据 */
export interface GitHubRepo {
  owner: string;
  name: string;
  /** 默认分支 */
  defaultBranch: string;
  /** 仓库是否私有 */
  private: boolean;
  /** 仓库描述 */
  description: string | null;
}

/** GitHub 树条目 */
export interface GitHubTreeItem {
  /** 路径 */
  path: string;
  /** 类型 */
  type: 'blob' | 'tree' | 'commit';
  /** SHA */
  sha: string;
  /** 文件大小（仅 blob） */
  size?: number;
  /** URL */
  url: string;
}

/** GitHub 树响应 */
export interface GitHubTreeResponse {
  sha: string;
  tree: GitHubTreeItem[];
  truncated: boolean;
}

/** GitHub 文件 blob 内容响应 */
export interface GitHubBlobResponse {
  content: string;
  encoding: 'base64';
  size: number;
  sha: string;
}

/** GitHub 分支信息 */
export interface GitHubBranch {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
}

// ---------------------------------------------------------------------------
// Octotree 内部树数据结构
// ---------------------------------------------------------------------------

/** Octotree 内部文件/目录节点 */
export interface OctotreeNode {
  /** 节点唯一标识 */
  id: string;
  /** 文件名/目录名 */
  name: string;
  /** 完整路径 */
  path: string;
  /** 节点类型 */
  type: 'blob' | 'tree';
  /** 子节点（仅目录） */
  children: OctotreeNode[] | null;
  /** 是否已展开 */
  expanded: boolean;
  /** 是否已加载子节点 */
  loaded: boolean;
  /** 文件扩展名 */
  extension: string;
  /** 文件大小 */
  size: number | null;
}

// ---------------------------------------------------------------------------
// 扩展运行时上下文
// ---------------------------------------------------------------------------

/** Content Script 运行时注入的全局状态 */
export interface OctotreeGlobalContext {
  /** 扩展是否已初始化 */
  OCTOTREE_INITIALIZED: boolean;
  /** 当前页面识别的 GitHub 仓库信息 */
  repo: GitHubRepo | null;
  /** 当前选中的分支/commit SHA */
  currentSha: string;
  /** 用户设置 */
  settings: OctotreeSettings;
  /** 访问令牌 */
  token: string | null;
}

/** 扩展到 window 对象的声明 */
declare global {
  interface Window {
    OCTOTREE_VERSION?: string;
    OCTOTREE_INITIALIZED?: boolean;
  }
}
