// ============================================================
// ADB v0.9.8 — TypeScript 类型定义
// 从原始 JS 代码逆向推断，覆盖数据模型、消息传递、存储 schema
// ============================================================

// --- 平台类型 ---

/** 弹出窗口支持的操作系统平台 */
export type PlatformClass = 'platform-windows' | 'platform-mac' | 'platform-linux';

/** User-Agent 匹配模式 */
export interface PlatformDetection {
  /** 正则字面量或 User-Agent 子串 */
  pattern: RegExp;
  /** 匹配后添加到 body 的 CSS class */
  className: PlatformClass;
}

// --- 后台页面 API ---

/**
 * 后台页面暴露给 popup 的公共接口。
 * 通过 chrome.extension.getBackgroundPage() 获取。
 */
export interface BackgroundPageAPI {
  /** 打开 chrome://inspect 标签页查看可调试设备 */
  devices(): void;
  /** 打开 Chrome 远程调试帮助文档 */
  help(): void;
  /** 打开 GitHub issue 页面提交工单 */
  ticket(): void;
}

// --- NPAPI 插件对象 ---

/**
 * 遗留 NPAPI ADB 插件对象。
 * 在 background.html 中以 <object type="application/x-adbplugin"> 声明。
 * Chrome 45+ 已移除 NPAPI 支持，此对象实际不再可用。
 */
export interface AdbPluginElement extends HTMLObjectElement {
  type: 'application/x-adbplugin';
}

// --- Popup DOM 结构 ---

/** Popup 页面中可交互的 DOM 元素引用 */
export interface PopupElements {
  /** "View Inspection Targets" 按钮（可能存在多个 .devices 元素） */
  devices: NodeListOf<HTMLElement>;
  /** "Help & Documentation" 链接 */
  help: HTMLElement | null;
  /** "File a ticket" 链接 */
  ticket: HTMLElement | null;
}

// --- Manifest 类型 ---

/**
 * 扩展 manifest.json 结构（MV2）
 */
export interface ADBManifest {
  name: 'ADB';
  version: `${number}.${number}.${number}`;
  description: string;
  manifest_version: 2;
  icons: {
    '128': string;
    '48': string;
  };
  background: {
    page: 'background.html';
  };
  browser_action: {
    default_icon: {
      '19': string;
      '38': string;
    };
    default_title: string;
    default_popup: 'popup.html';
  };
  update_url: string;
}

// --- UrlTargets (chrome.tabs.create 参数) ---

/** chrome.tabs.create 调用中使用的目标 URL 常量 */
export const enum UrlTargets {
  /** Chrome 内置设备检查页面 */
  INSPECT = 'chrome://inspect',
  /** Google Developers 远程调试文档 */
  HELP = 'https://developers.google.com/chrome-developer-tools/docs/remote-debugging',
  /** ADB Plugin GitHub 仓库 */
  TICKET = 'https://github.com/GoogleChrome/ADBPlugin',
}
