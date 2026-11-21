// ============================================================
// MarkDownload v3.4.0 — TypeScript 类型定义
// 从 background.js / contentScript.js / popup.js / options.js 逆向推断
// ============================================================

// ---- Chrome 扩展 API 全局声明 ----
declare const browser: typeof chrome;

// ---- 第三方库全局声明 ----
declare class TurndownService {
  escape: (s: string) => string;
  defaultEscape: (s: string) => string;
  constructor(options?: Partial<TurndownOptions>);
  use(plugin: unknown): void;
  keep(tags: string[]): void;
  addRule(key: string, rule: TurndownRule): void;
  turndown(content: string | Node): string;
}

declare class Readability {
  constructor(doc: Document);
  parse(): Article;
}

declare const turndownPluginGfm: { gfm: unknown };

declare const moment: (date: Date) => { format(fmt: string): string };

declare const mimedb: Record<string, string>;

declare const CodeMirror: {
  fromTextArea(el: HTMLTextAreaElement | null, opts: CodeMirrorOptions): CodeMirrorEditor;
};

// ---- Turndown 配置 ----
interface TurndownOptions {
  headingStyle: 'setext' | 'atx';
  hr: '***' | '---' | '___';
  bulletListMarker: '-' | '*' | '+';
  codeBlockStyle: 'indented' | 'fenced';
  fence: '```' | '~~~';
  emDelimiter: '_' | '*' | '__';
  strongDelimiter: '**' | '__';
  linkStyle: 'inlined' | 'referenced' | 'stripLinks';
  linkReferenceStyle: 'full' | 'collapsed' | 'shortcut';
  turndownEscape: boolean;
  // 以下为 MarkDownload 扩展字段
  downloadImages: boolean;
  imageStyle: ImageStyle;
  imageRefStyle: 'inlined' | 'referenced';
  imagePrefix: string;
  frontmatter: string;
  backmatter: string;
  title: string;
  includeTemplate: boolean;
  disallowedChars: string;
  downloadMode: DownloadMode;
}

type ImageStyle = 'markdown' | 'base64' | 'originalSource' | 'noImage' | 'obsidian' | 'obsidian-nofolder';

type DownloadMode = 'downloadsApi' | 'contentLink';

// ---- Turndown 规则 ----
interface TurndownRule {
  filter: (node: HTMLElement, options: TurndownOptions) => boolean;
  replacement: (content: string, node: HTMLElement, options: TurndownOptions) => string;
  references?: string[];
  append?: (options: TurndownOptions) => string;
}

// ---- CodeMirror 类型 ----
interface CodeMirrorOptions {
  theme: string;
  mode: string;
  lineWrapping: boolean;
}

interface CodeMirrorEditor {
  on(event: string, cb: (cm: CodeMirrorEditor) => void): void;
  setValue(value: string): void;
  getValue(): string;
  getSelection(): string;
  somethingSelected(): boolean;
  refresh(): void;
}

// ---- 选项配置 (storage.sync 存储) ----
interface MarkDownloadOptions {
  // Turndown 基础选项
  headingStyle: 'setext' | 'atx';
  hr: '***' | '---' | '___';
  bulletListMarker: '-' | '*' | '+';
  codeBlockStyle: 'indented' | 'fenced';
  fence: '```' | '~~~';
  emDelimiter: '_' | '*' | '__';
  strongDelimiter: '**' | '__';
  linkStyle: 'inlined' | 'referenced' | 'stripLinks';
  linkReferenceStyle: 'full' | 'collapsed' | 'shortcut';

  // 图片选项
  imageStyle: ImageStyle;
  imageRefStyle: 'inlined' | 'referenced';
  imagePrefix: string;

  // 模板选项
  frontmatter: string;
  backmatter: string;
  title: string;
  includeTemplate: boolean;
  disallowedChars: string;

  // 下载与功能
  saveAs: boolean;
  downloadImages: boolean;
  downloadMode: DownloadMode;
  turndownEscape: boolean;
  contextMenus: boolean;

  // Obsidian 集成
  obsidianIntegration: boolean;
  obsidianVault: string;
  obsidianFolder: string;

  // 文件夹
  mdClipsFolder: string | null;
}

// 默认选项常量
declare const defaultOptions: MarkDownloadOptions;

// ---- Article 数据模型 (Readability 解析结果) ----
interface Article {
  // Readability 标准字段
  title: string;
  content: string;
  length: number;
  excerpt: string;
  byline: string;
  dir: string;
  textContent: string;
  siteName: string;
  lang: string;

  // MarkDownload 扩展字段
  baseURI: string;
  pageTitle: string;
  hash: string;
  host: string;
  origin: string;
  hostname: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  keywords: string[];
  math: Record<string, MathInfo>;

  // 动态 meta 标签字段 (key 为 meta name/property)
  [key: string]: unknown;
}

// ---- Math 渲染信息 ----
interface MathInfo {
  tex: string;
  inline: boolean;
}

// ---- 图片映射表 ----
interface ImageMap {
  [srcUrl: string]: string; // 原始 URL -> 目标文件名
}

// ---- 消息类型 (browser.runtime.sendMessage) ----

// 消息基础类型
interface BaseMessage {
  type: string;
}

// contentScript -> background: 裁剪请求
interface ClipMessage extends BaseMessage {
  type: 'clip';
  dom: string;
  selection?: string;
  clipSelection?: boolean;
}

// background -> popup: 显示 Markdown
interface DisplayMdMessage extends BaseMessage {
  type: 'display.md';
  markdown: string;
  article: Article;
  imageList: ImageMap;
  mdClipsFolder: string;
}

// popup -> background: 下载请求
interface DownloadMessage extends BaseMessage {
  type: 'download';
  markdown: string;
  title: string;
  tab: { id: number };
  imageList: ImageMap;
  mdClipsFolder: string;
}

type ExtensionMessage = ClipMessage | DisplayMdMessage | DownloadMessage;

// ---- Turndown 转换结果 ----
interface TurndownResult {
  markdown: string;
  imageList: ImageMap;
}

// ---- Context Menu 相关常量 ----
type ContextMenuId =
  | 'download-markdown-tab'
  | 'tab-download-markdown-alltabs'
  | 'copy-tab-as-markdown-link-tab'
  | 'copy-tab-as-markdown-link-all-tab'
  | 'copy-tab-as-markdown-link-selected-tab'
  | 'download-markdown-alltabs'
  | 'download-markdown-selection'
  | 'download-markdown-all'
  | 'copy-markdown-selection'
  | 'copy-markdown-link'
  | 'copy-markdown-image'
  | 'copy-markdown-all'
  | 'copy-tab-as-markdown-link'
  | 'copy-tab-as-markdown-link-all'
  | 'copy-tab-as-markdown-link-selected'
  | 'copy-markdown-obsidian'
  | 'copy-markdown-obsall'
  | 'toggle-includeTemplate'
  | 'tabtoggle-includeTemplate'
  | 'toggle-downloadImages'
  | 'tabtoggle-downloadImages';

// ---- 快捷键命令 ----
type KeyboardCommand =
  | 'download_tab_as_markdown'
  | 'copy_tab_as_markdown'
  | 'copy_selection_as_markdown'
  | 'copy_tab_as_markdown_link'
  | 'copy_selected_tab_as_markdown_link'
  | 'copy_selection_to_obsidian'
  | 'copy_tab_to_obsidian';
