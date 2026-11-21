/**
 * i18n 国际化模块
 *
 * 支持 16 种语言
 */

/**
 * 支持的语言列表
 */
export const SUPPORTED_LANGUAGES = [
  'en', // English
  'zh', // Chinese
  'es', // Spanish
  'fr', // French
  'de', // German
  'ja', // Japanese
  'ko', // Korean
  'pt', // Portuguese
  'ru', // Russian
  'ar', // Arabic
  'it', // Italian
  'nl', // Dutch
  'pl', // Polish
  'tr', // Turkish
  'vi', // Vietnamese
  'th', // Thai
] as const;

/**
 * 语言代码类型
 */
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * 翻译键枚举
 */
export const TranslationKey = {
  // 扩展名称
  EXT_NAME: 'extName',
  EXT_DESCRIPTION: 'extDescription',

  // 操作
  OPEN_YOUMIND: 'openYouMind',
  START_CAPTURE: 'startCapture',
  SAVE_WEBPAGE_TO_YOUMIND: 'saveWepageToYouMind',
  START_TRANSLATE: 'startTranslate',

  // 上下文菜单
  SAVE_CONTENT_TO_YOUMIND: 'Save Content to YouMind',
  SAVE_IMAGE_TO_YOUMIND: 'Save Image to YouMind',
  SAVE_LINK_TO_YOUMIND: 'Save Link to YouMind',
  SAVE_PAGE_TO_YOUMIND: 'Save Page to YouMind',

  // 状态
  LOADING: 'loading',
  SUCCESS: 'success',
  ERROR: 'error',
  SAVED: 'saved',

  // YouTube
  YOUTUBE_VIDEO_INFO: 'youtubeVideoInfo',
  YOUTUBE_SUBTITLE: 'youtubeSubtitle',

  // AI
  AI_ANALYZING: 'aiAnalyzing',
  AI_SUMMARY: 'aiSummary',
} as const;

/**
 * 翻译键类型
 */
export type TKey = (typeof TranslationKey)[keyof typeof TranslationKey];

/**
 * 默认翻译（英语）
 */
const defaultTranslations: Record<string, string> = {
  extName: 'YouMind - AI Web Clipper',
  extDescription: 'Save web content, YouTube videos, and tweets to YouMind with AI assistance',

  openYouMind: 'Open YouMind',
  startCapture: 'Start Capture',
  saveWepageToYouMind: 'Save to YouMind',
  startTranslate: 'Start Translate',

  'Save Content to YouMind': 'Save Content to YouMind',
  'Save Image to YouMind': 'Save Image to YouMind',
  'Save Link to YouMind': 'Save Link to YouMind',
  'Save Page to YouMind': 'Save Page to YouMind',

  loading: 'Loading...',
  success: 'Success',
  error: 'Error',
  saved: 'Saved!',

  youtubeVideoInfo: 'YouTube Video Info',
  youtubeSubtitle: 'YouTube Subtitle',

  aiAnalyzing: 'AI is analyzing...',
  aiSummary: 'AI Summary',
};

/**
 * 当前语言
 */
let currentLanguage: LanguageCode = 'en';

/**
 * 初始化 i18n
 */
export async function initI18n(): Promise<void> {
  // 获取浏览器语言
  const browserLang = chrome.i18n.getUILanguage?.() || 'en';

  // 映射到支持的语言
  currentLanguage = mapLanguageCode(browserLang);

  // 从存储获取用户设置的语言
  const result = await new Promise<Record<string, LanguageCode>>((resolve) => {
    chrome.storage.local.get('language', resolve);
  });

  if (result.language && SUPPORTED_LANGUAGES.includes(result.language)) {
    currentLanguage = result.language;
  }
}

/**
 * 映射语言代码
 * @param code 浏览器语言代码
 * @returns 支持的语言代码
 */
function mapLanguageCode(code: string): LanguageCode {
  const lang = code.split('-')[0].toLowerCase();

  if (SUPPORTED_LANGUAGES.includes(lang as LanguageCode)) {
    return lang as LanguageCode;
  }

  return 'en'; // 默认英语
}

/**
 * 获取翻译
 * @param key 翻译键
 * @param args 替换参数
 * @returns 翻译后的文本
 */
export function t(key: string, args?: Record<string, string | number>): string {
  // 首先尝试使用 Chrome i18n API
  const chromeTranslation = chrome.i18n.getMessage(key);
  if (chromeTranslation) {
    return replacePlaceholders(chromeTranslation, args);
  }

  // 回退到默认翻译
  let translation = defaultTranslations[key] || key;

  // 替换占位符
  return replacePlaceholders(translation, args);
}

/**
 * 替换占位符
 * @param text 文本
 * @param args 参数
 * @returns 替换后的文本
 */
function replacePlaceholders(
  text: string,
  args?: Record<string, string | number>
): string {
  if (!args) {
    return text;
  }

  return text.replace(/\$\{(\w+)\}/g, (match, key) => {
    return args[key]?.toString() || match;
  });
}

/**
 * 获取当前语言
 * @returns 当前语言代码
 */
export function getCurrentLanguage(): LanguageCode {
  return currentLanguage;
}

/**
 * 设置语言
 * @param lang 语言代码
 */
export async function setLanguage(lang: LanguageCode): Promise<void> {
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    throw new Error(`Unsupported language: ${lang}`);
  }

  currentLanguage = lang;

  // 保存到存储
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ language: lang }, () => resolve());
  });
}

/**
 * 获取所有翻译
 * @param lang 语言代码
 * @returns 翻译对象
 */
export function getTranslations(lang?: LanguageCode): Record<string, string> {
  const targetLang = lang || currentLanguage;

  // 尝试从 messages 目录加载
  try {
    const messages = require(`../../_locales/${targetLang}/messages.json`);
    return messages;
  } catch {
    // 回退到默认翻译
    return defaultTranslations;
  }
}

/**
 * 格式化数字
 * @param num 数字
 * @returns 格式化后的字符串
 */
export function formatNumber(num: number): string {
  return new Intl.NumberFormat(currentLanguage).format(num);
}

/**
 * 格式化日期
 * @param date 日期
 * @param options 选项
 * @returns 格式化后的日期字符串
 */
export function formatDate(
  date: Date,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(currentLanguage, options).format(date);
}

/**
 * 格式化相对时间
 * @param date 日期
 * @returns 相对时间字符串（如 "2 hours ago"）
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  const rtf = new Intl.RelativeTimeFormat(currentLanguage, { numeric: 'auto' });

  if (diffSec < 60) {
    return rtf.format(-diffSec, 'second');
  } else if (diffMin < 60) {
    return rtf.format(-diffMin, 'minute');
  } else if (diffHour < 24) {
    return rtf.format(-diffHour, 'hour');
  } else {
    return rtf.format(-diffDay, 'day');
  }
}

// 初始化 i18n
initI18n().catch(console.error);
