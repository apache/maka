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
  startRecording: string;
  startRecordingAria: string;
  stopRecording: string;
  stopRecordingAria: string;
  saveRecording: string;
  discardRecording: string;
  discardRecordingAria: string;
  saveRecordingAria: string;
  recordingName: string;
  defaultWorkflowName: string;
  recordingProgress: (current: number, total: number) => string;
  recordingSaved: string;
  cancelReplay: string;
  waitConditionGroup: string;
  waitSelectorMode: string;
  waitTextMode: string;
  waitSelectorLabel: string;
  waitTextLabel: string;
  recordWaitCondition: string;
  recordWaitConditionAria: string;
  reviewRecording: string;
  actionNavigate: string;
  actionClick: string;
  actionCheck: string;
  actionUncheck: string;
  actionType: string;
  actionSensitiveType: string;
  actionWaitNavigation: string;
  actionWaitSelector: string;
  actionWaitText: string;
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
    startRecording: '录制操作流程',
    startRecordingAria: '开始录制操作流程',
    stopRecording: '停止录制',
    stopRecordingAria: '停止录制操作流程',
    saveRecording: '保存操作流程',
    discardRecording: '放弃操作流程草稿',
    discardRecordingAria: '放弃操作流程草稿',
    saveRecordingAria: '保存操作流程',
    recordingName: '操作流程名称',
    defaultWorkflowName: '操作流程',
    recordingProgress: (current, total) => total > 0 ? `回放 ${current}/${total}` : `已记录 ${current} 个动作`,
    recordingSaved: '操作流程已保存',
    cancelReplay: '取消回放',
    waitConditionGroup: '记录可观察等待条件',
    waitSelectorMode: 'CSS 选择器',
    waitTextMode: '可见文本',
    waitSelectorLabel: '等待 CSS 选择器',
    waitTextLabel: '等待可见文本',
    recordWaitCondition: '记录等待条件',
    recordWaitConditionAria: '记录当前可观察等待条件',
    reviewRecording: '录制步骤预览',
    actionNavigate: '导航',
    actionClick: '点击',
    actionCheck: '选中',
    actionUncheck: '取消选中',
    actionType: '输入',
    actionSensitiveType: '敏感输入',
    actionWaitNavigation: '等待页面跳转',
    actionWaitSelector: '等待选择器',
    actionWaitText: '等待文本',
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
    startRecording: 'Record workflow',
    startRecordingAria: 'Start recording browser workflow',
    stopRecording: 'Stop recording',
    stopRecordingAria: 'Stop recording browser workflow',
    saveRecording: 'Save workflow',
    discardRecording: 'Discard workflow draft',
    discardRecordingAria: 'Discard browser workflow draft',
    saveRecordingAria: 'Save browser workflow',
    recordingName: 'Workflow name',
    defaultWorkflowName: 'Browser workflow',
    recordingProgress: (current, total) => total > 0 ? `Replay ${current}/${total}` : `${current} actions recorded`,
    recordingSaved: 'Workflow saved',
    cancelReplay: 'Cancel replay',
    waitConditionGroup: 'Record observable wait condition',
    waitSelectorMode: 'CSS selector',
    waitTextMode: 'Visible text',
    waitSelectorLabel: 'Wait for CSS selector',
    waitTextLabel: 'Wait for visible text',
    recordWaitCondition: 'Record wait condition',
    recordWaitConditionAria: 'Record the currently observable wait condition',
    reviewRecording: 'Recorded steps',
    actionNavigate: 'Navigate',
    actionClick: 'Click',
    actionCheck: 'Check',
    actionUncheck: 'Uncheck',
    actionType: 'Type',
    actionSensitiveType: 'Sensitive input',
    actionWaitNavigation: 'Wait for navigation',
    actionWaitSelector: 'Wait for selector',
    actionWaitText: 'Wait for text',
  },
} satisfies UiCatalog<BrowserCopy>;

export function getBrowserCopy(locale: UiLocale): BrowserCopy {
  return BROWSER_COPY[locale];
}
