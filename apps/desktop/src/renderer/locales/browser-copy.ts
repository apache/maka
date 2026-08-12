import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type BrowserCopy = {
  unsupportedScheme: string;
  invalidUrl: string;
  openFailed: string;
  navigationFailed: string;
  navigationFailedDetail: string;
  panelAria: string;
  backAria: string;
  back: string;
  forwardAria: string;
  forward: string;
  stopAria: string;
  refreshAria: string;
  stop: string;
  refresh: string;
  addressAria: string;
  addressPlaceholder: string;
  closeAria: string;
  close: string;
  title: string;
  description: string;
};

const BROWSER_COPY = {
  zh: {
    unsupportedScheme: '嵌入式浏览器只支持打开 HTTP/HTTPS 网页地址。',
    invalidUrl: '这个地址无法识别，请检查网址后重试。',
    openFailed: '无法打开地址',
    navigationFailed: '浏览器导航失败',
    navigationFailedDetail: '页面暂时无法打开，请稍后重试。',
    panelAria: '嵌入式浏览器',
    backAria: '浏览器后退',
    back: '后退',
    forwardAria: '浏览器前进',
    forward: '前进',
    stopAria: '停止加载页面',
    refreshAria: '刷新页面',
    stop: '停止',
    refresh: '刷新',
    addressAria: '浏览器地址',
    addressPlaceholder: '输入网址并回车',
    closeAria: '关闭浏览器页面',
    close: '关闭页面',
    title: '嵌入式浏览器',
    description: '输入网址打开页面，或让助手帮你导航并操作。',
  },
  en: {
    unsupportedScheme: 'The embedded browser only supports HTTP and HTTPS addresses.',
    invalidUrl: 'This address is not valid. Check it and try again.',
    openFailed: 'Could not open address',
    navigationFailed: 'Browser navigation failed',
    navigationFailedDetail: 'The page could not be opened. Try again later.',
    panelAria: 'Embedded browser',
    backAria: 'Go back in browser',
    back: 'Back',
    forwardAria: 'Go forward in browser',
    forward: 'Forward',
    stopAria: 'Stop loading page',
    refreshAria: 'Reload page',
    stop: 'Stop',
    refresh: 'Reload',
    addressAria: 'Browser address',
    addressPlaceholder: 'Enter an address and press Enter',
    closeAria: 'Close browser page',
    close: 'Close page',
    title: 'Embedded browser',
    description: 'Enter an address, or ask the assistant to navigate and interact with a page.',
  },
} satisfies UiCatalog<BrowserCopy>;

export function getBrowserCopy(locale: UiLocale): BrowserCopy {
  return BROWSER_COPY[locale];
}
