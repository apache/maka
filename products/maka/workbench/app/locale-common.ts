/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { Catalog } from '../../../../plugins/shared/locale.js';
import {
  msg_cancel,
  msg_checklistRetry,
  msg_closeModels,
  msg_copy,
  msg_helpNew,
  msg_models,
  msg_thinkingUnavailable,
} from '../../../../plugins/shared/locale-messages.js';

/** Shared interface terms have one translation owner across every surface. */
export const commonMessages = {
  'Choose a search folder in Settings.': [
    'Choose a search folder in Settings.',
    '请在设置中选择搜索文件夹。',
    '請在設定中選擇搜尋檔案夾。',
  ],
  'Folder unavailable': ['Folder unavailable', '文件夹不可用', '檔案夾無法使用'],
  'Folder missing or volume disconnected': [
    'Folder missing or volume disconnected',
    '目录不存在或磁盘已断开',
    '目錄不存在或磁碟已斷開',
  ],
  'Some subfolders could not be read': [
    'Some subfolders could not be read',
    '部分子文件夹无法读取',
    '部分子檔案夾無法讀取',
  ],
  'Folder access required': ['Folder access required', '需要文件夹访问权限', '需要檔案夾存取權限'],
  'Indexing…': ['Indexing…', '正在索引…', '正在索引…'],
  Indexed: ['Indexed', '已索引', '已索引'],
  'Add a search folder': ['Add a search folder', '添加搜索文件夹', '加入搜尋檔案夾'],
  'Other personal files': [
    'Other personal files',
    '主目录中的其他个人文件',
    '家目錄中的其他個人檔案',
  ],
  'Search includes subfolders. Select a mounted volume or add a folder.': [
    'Search includes subfolders. Select a mounted volume or add a folder.',
    '包含子文件夹。可以选择已挂载的磁盘，或添加指定文件夹。',
    '包含子檔案夾。可選擇已掛載的磁碟，或加入指定檔案夾。',
  ],
  'Search folders': ['Search folders', '搜索范围', '搜尋範圍'],
  'Allow Maka to read Downloads in System Settings > Privacy & Security > Files and Folders.': [
    'Allow Maka to read Downloads in System Settings > Privacy & Security > Files and Folders.',
    '请在系统设置的「隐私与安全性 → 文件与文件夹」中允许 Maka 读取下载文件夹。',
    '請在系統設定的「隱私權與安全性 → 檔案與檔案夾」中允許 Maka 讀取下載項目。',
  ],
  'Clipboard format': ['Format', '格式', '格式'],
  'Clipboard text': ['Text', '文本', '文字'],
  'Pixel dimensions': ['Dimensions', '图片尺寸', '圖片尺寸'],
  'Copied at': ['Copied at', '复制时间', '複製時間'],
  'Abandon unconfirmed {method}': [
    'Abandon unconfirmed {method}',
    '放弃尚未确认的 {method}',
    '放棄尚未確認的 {method}',
  ],
  'Ask Maka': ['Ask Maka', '询问 Maka', '詢問 Maka'],
  'Ask a follow-up': ['Ask a follow-up', '继续询问', '繼續詢問'],
  'No model is available': ['No model is available', '还没有可用的模型', '還沒有可用的模型'],
  'Choose Model': ['Choose Model', '选择模型', '選擇模型'],
  'Connection interrupted. Reconnect to continue; your draft is kept.': [
    'Connection interrupted. Reconnect to continue; your draft is kept.',
    '连接已中断，重新连接后可继续。草稿已保留。',
    '連線已中斷，重新連線後可繼續。草稿已保留。',
  ],
  'Conversation data is temporarily unavailable. Try reconnecting.': [
    'Conversation data is temporarily unavailable. Try reconnecting.',
    '暂时无法读取会话数据，请尝试重新连接。',
    '暫時無法讀取對話資料，請嘗試重新連線。',
  ],
  'Conversation list is temporarily unavailable. Try reconnecting.': [
    'Conversation list is temporarily unavailable. Try reconnecting.',
    '暂时无法读取会话列表，请尝试重新连接。',
    '暫時無法讀取對話清單，請嘗試重新連線。',
  ],
  'Maka Bot could not be opened': [
    'Maka Bot could not be opened',
    '无法打开 Maka Bot',
    '無法開啟 Maka Bot',
  ],
  'Open Maka': ['Open Maka', '打开 Maka', '打開 Maka'],
  'Open in Main Window': ['Open in Main Window', '在主窗口打开', '在主視窗開啟'],
  'Quit Maka': ['Quit Maka', '退出 Maka', '結束 Maka'],
  'The Alt+Space shortcut is unavailable': [
    'The Alt+Space shortcut is unavailable',
    'Alt+Space 快捷键不可用',
    'Alt+Space 快捷鍵無法使用',
  ],
  'The Option+Space shortcut is unavailable': [
    'The Option+Space shortcut is unavailable',
    'Option+Space 快捷键不可用',
    'Option+Space 快捷鍵無法使用',
  ],
  'The action outcome is unknown. Check the current state before trying again.': [
    'The action outcome is unknown. Check the current state before trying again.',
    '暂时无法确认操作结果，请先检查当前状态再决定是否重试。',
    '暫時無法確認操作結果，請先檢查目前狀態再決定是否重試。',
  ],
  Cancel: msg_cancel,
  'Choose workspace': ['Choose workspace', '选择工作区', '選擇工作區'],
  Close: msg_closeModels,
  'Close · Esc': ['Close · Esc', '关闭 · Esc', '關閉 · Esc'],
  Copy: msg_copy,
  'Connections & models': ['Connections & models', '连接与模型', '連線與模型'],
  'Add a model connection': ['Add a model connection', '添加模型连接', '新增模型連線'],
  'Conversations need a model. Add a connection with your API key or account first.': [
    'Conversations need a model. Add a connection with your API key or account first.',
    '对话需要一个模型。请先用 API 密钥或账号添加一个连接。',
    '對話需要一個模型。請先用 API 金鑰或帳號新增一個連線。',
  ],
  'Draft could not be saved or restored. Its existing contents are preserved.': [
    'Draft could not be saved or restored. Its existing contents are preserved.',
    '无法保存或恢复草稿。已有内容已保留。',
    '無法儲存或還原草稿。既有內容已保留。',
  ],
  Edit: ['Edit', '编辑', '編輯'],
  Failed: ['Failed', '失败', '失敗'],
  'Loading…': ['Loading…', '正在加载…', '正在載入…'],
  Models: msg_models,
  'New conversation': msg_helpNew,
  'Original image': ['Original image', '原始图片', '原始圖片'],
  'Press Ctrl+C again to exit.': [
    'Press Ctrl+C again to exit.',
    '再按一次 Ctrl+C 退出。',
    '再按一次 Ctrl+C 結束。',
  ],
  'Stop the current task?': [
    'Stop the current task?',
    '要停止当前任务吗？',
    '要停止目前的工作嗎？',
  ],
  'The task will keep running unless you choose to stop it.': [
    'The task will keep running unless you choose to stop it.',
    '只有选择停止，才会中断当前任务。',
    '只有選擇停止，才會中斷目前的工作。',
  ],
  'Stop task': ['Stop task', '停止任务', '停止工作'],
  Retry: msg_checklistRetry,
  Save: ['Save', '保存', '儲存'],
  Skills: ['Skills', '技能', '技能'],
  'shared · view only': ['shared · view only', '共享 · 仅查看', '共用 · 僅檢視'],
  'Stop process': ['Stop process', '停止进程', '停止處理程序'],
  Terminal: ['Terminal', '终端', '終端機'],
  Unavailable: msg_thinkingUnavailable,
  'Untitled conversation': ['Untitled conversation', '未命名对话', '未命名對話'],
  View: ['View', '显示', '顯示'],
  Window: ['Window', '窗口', '視窗'],
  'Add to {section}': ['Add to {section}', '添加到{section}', '新增到{section}'],
  'Capture a screen region': ['Capture a screen region', '截取屏幕区域', '擷取螢幕區域'],
  'Allow Maka under Screen & System Audio Recording in System Settings, then take the screenshot again.':
    [
      'Allow Maka under Screen & System Audio Recording in System Settings, then take the screenshot again.',
      '请在系统设置的“录屏与系统录音”中允许 Maka，然后重新截图。',
      '請在系統設定的「螢幕與系統錄音」中允許 Maka，然後重新截圖。',
    ],
  'The screenshot failed: {reason}': [
    'The screenshot failed: {reason}',
    '截图失败：{reason}',
    '截圖失敗：{reason}',
  ],
  'Press any key to close': ['Press any key to close', '按任意键关闭', '按任意鍵關閉'],
  'Open System Settings': ['Open System Settings', '打开系统设置', '打開系統設定'],
  Rectangle: ['Rectangle', '矩形', '矩形'],
  Ellipse: ['Ellipse', '椭圆', '橢圓'],
  Arrow: ['Arrow', '箭头', '箭頭'],
  Pen: ['Pen', '画笔', '畫筆'],
  Highlighter: ['Highlighter', '荧光笔', '螢光筆'],
  Mosaic: ['Mosaic', '马赛克', '馬賽克'],
  'Numbered marker': ['Numbered marker', '序号', '序號'],
  Undo: ['Undo', '撤销', '復原'],
  Redo: ['Redo', '重做', '重做'],
  'Pin to screen': ['Pin to screen', '贴到屏幕', '貼到螢幕'],
  Thin: ['Thin', '细', '細'],
  Medium: ['Medium', '中', '中'],
  Thick: ['Thick', '粗', '粗'],
  Saving: ['Saving', '保存', '儲存'],
  'Save to': ['Save to', '保存到', '儲存到'],
  'Where macOS saves its screenshots': [
    'Where macOS saves its screenshots',
    'macOS 系统截图的保存位置',
    'macOS 系統截圖的儲存位置',
  ],
  'Use macOS’s folder': ['Use macOS’s folder', '使用系统位置', '使用系統位置'],
  'Choose…': ['Choose…', '选择…', '選擇…'],
  Marks: ['Marks', '标注', '標註'],
  'Each screenshot starts with these.': [
    'Each screenshot starts with these.',
    '每次截图开始时使用这些设置。',
    '每次截圖開始時使用這些設定。',
  ],
  Color: ['Color', '颜色', '顏色'],
  'Line width': ['Line width', '粗细', '粗細'],
  Snapping: ['Snapping', '吸附', '吸附'],
  'Snap to boxes in the picture': [
    'Snap to boxes in the picture',
    '吸附画面中的矩形',
    '吸附畫面中的矩形',
  ],
  'Besides windows and their controls, blocks of one color and outlined boxes, such as buttons and fields in web pages and terminals.':
    [
      'Besides windows and their controls, blocks of one color and outlined boxes, such as buttons and fields in web pages and terminals.',
      '除了窗口和控件，还吸附纯色块和描边框，例如网页和终端里的按钮、输入框。',
      '除了視窗和控制項，還吸附純色塊和描邊框，例如網頁和終端機裡的按鈕、輸入框。',
    ],
  'Allow Accessibility to snap to the controls inside windows.': [
    'Allow Accessibility to snap to the controls inside windows.',
    '允许辅助功能后，可以吸附窗口里的控件。',
    '允許輔助使用後，可以吸附視窗裡的控制項。',
  ],
  'Confirm delete': ['Confirm delete', '确认删除', '確認刪除'],
  Content: ['Content', '内容', '內容'],
  'Enter a URL starting with http:// or https://': [
    'Enter a URL starting with http:// or https://',
    '请输入以 http:// 或 https:// 开头的网址',
    '請輸入以 http:// 或 https:// 開頭的網址',
  ],
  'Enter a name': ['Enter a name', '请输入名称', '請輸入名稱'],
  'Enter some content': ['Enter some content', '请输入内容', '請輸入內容'],
  Links: ['Links', '链接', '連結'],
  'Nothing here yet': ['Nothing here yet', '暂无内容', '尚無內容'],
  Notes: ['Notes', '笔记', '筆記'],
  'Put {query} in a URL to fill it with the text typed after the name.': [
    'Put {query} in a URL to fill it with the text typed after the name.',
    '在网址里写 {query}，会用名称后面输入的文字替换。',
    '在網址裡寫 {query}，會用名稱後面輸入的文字取代。',
  ],
  Snippets: ['Snippets', '片段', '片段'],
  'The content is too long': ['The content is too long', '内容太长', '內容太長'],
  'The link could not be opened': ['The link could not be opened', '无法打开链接', '無法開啟連結'],
  'The name is too long': ['The name is too long', '名称太长', '名稱太長'],
  URL: ['URL', '网址', '網址'],
  Name: ['Name', '名称', '名稱'],
  Open: ['Open', '打开', '開啟'],
  Recommended: ['Recommended', '推荐', '推薦'],
  'Recently used': ['Recently used', '最近使用', '最近使用'],
  'Frequently used': ['Frequently used', '常用', '常用'],
  'Search tools or ask Maka': [
    'Search tools or ask Maka',
    '搜索工具，或询问 Maka',
    '搜尋工具，或詢問 Maka',
  ],
  'Copy and close': ['Copy and close', '复制并关闭', '複製並關閉'],
  'Maka plugins': ['Maka plugins', 'Maka 插件', 'Maka 外掛'],
  'Quick tools': ['Quick tools', '快捷工具', '快速工具'],
  'Tools in the quick launcher. Their commands and settings are under Quick tools.': [
    'Tools in the quick launcher. Their commands and settings are under Quick tools.',
    '快捷面板里的工具。它们的命令和设置在“快捷工具”中。',
    '快速面板裡的工具。它們的命令和設定在「快速工具」中。',
  ],
  'In the quick launcher, {shortcut} on a selected tool opens these same settings.': [
    'In the quick launcher, {shortcut} on a selected tool opens these same settings.',
    '在快捷面板中选中工具后按 {shortcut} 可打开同样的设置。',
    '在快速面板中選取工具後按 {shortcut} 可開啟同樣的設定。',
  ],
  'No quick tools to set up.': [
    'No quick tools to set up.',
    '没有可设置的快捷工具。',
    '沒有可設定的快速工具。',
  ],
  'Search {tool}': ['Search {tool}', '搜索{tool}', '搜尋{tool}'],
  'Turn on quick tools': ['Turn on quick tools', '启用快捷工具', '啟用快速工具'],
  'Press {shortcut} anywhere to open the quick launcher, with its tools, commands and Maka Bot. Still being refined.':
    [
      'Press {shortcut} anywhere to open the quick launcher, with its tools, commands and Maka Bot. Still being refined.',
      '在任何地方按 {shortcut} 打开快捷面板，使用其中的工具、命令和 Maka Bot。仍在完善中。',
      '在任何地方按 {shortcut} 開啟快速面板，使用其中的工具、命令和 Maka Bot。仍在完善中。',
    ],
  'Quick launcher': ['Quick launcher', '快捷面板', '快速面板'],
  'Shortcut to open the quick launcher': [
    'Shortcut to open the quick launcher',
    '打开快捷面板的快捷键',
    '開啟快速面板的快速鍵',
  ],
  'The {shortcut} shortcut is unavailable': [
    'The {shortcut} shortcut is unavailable',
    '快捷键 {shortcut} 不可用',
    '快速鍵 {shortcut} 無法使用',
  ],
  'Record shortcut': ['Record shortcut', '录制快捷键', '錄製快速鍵'],
  'Press keys…': ['Press keys…', '请按下快捷键…', '請按下快速鍵…'],
  'Remove shortcut': ['Remove shortcut', '移除快捷键', '移除快速鍵'],
  'Used by a disabled tool': [
    'Used by a disabled tool',
    '已被停用的工具使用',
    '已被停用的工具使用',
  ],
  'Used by {title}': ['Used by {title}', '已被“{title}”使用', '已被「{title}」使用'],
  'Taken by another app': ['Taken by another app', '已被其他应用占用', '已被其他 App 佔用'],
  Alias: ['Alias', '别名', '別名'],
  'A shortcut runs the command from any app. Typing the alias finds it; left empty, the built-in alias is used.':
    [
      'A shortcut runs the command from any app. Typing the alias finds it; left empty, the built-in alias is used.',
      '快捷键可在任何应用中直接运行命令。输入别名即可找到命令；留空时使用内置别名。',
      '快速鍵可在任何 App 中直接執行命令。輸入別名即可找到命令；留空時使用內建別名。',
    ],
  Navigate: ['Navigate', '切换', '切換'],
  Application: ['Application', '应用', '應用程式'],
  'Search applications': ['Search applications', '搜索应用', '搜尋應用程式'],
  Calculator: ['Calculator', '计算器', '計算機'],
  Clipboard: ['Clipboard', '剪贴板', '剪貼簿'],
  'Clipboard history': ['Clipboard history', '剪贴板历史', '剪貼簿歷史'],
  'Entries kept': ['Entries kept', '保留条数', '保留筆數'],
  'Clear history': ['Clear history', '清空历史', '清除歷史'],
  '{count} entries': ['{count} entries', '共 {count} 条', '共 {count} 筆'],
  Clear: ['Clear', '清空', '清除'],
  'Confirm clear': ['Confirm clear', '确认清空', '確認清除'],
  'Kept in memory only and gone when Maka quits. Copies from password managers are skipped.': [
    'Kept in memory only and gone when Maka quits. Copies from password managers are skipped.',
    '只保存在内存中，退出 Maka 后清空；不记录密码管理器复制的内容。',
    '只保存在記憶體中，結束 Maka 後清除；不記錄密碼管理器複製的內容。',
  ],
  Note: ['Note', '笔记', '筆記'],
  Snippet: ['Snippet', '片段', '片段'],
  Symbol: ['Symbol', '符号', '符號'],
  Symbols: ['Symbols', '符号', '符號'],
  'screenshot keyword': ['screenshot', '截图', '截圖'],
  Delete: ['Delete', '删除', '刪除'],
} as const satisfies Catalog;
