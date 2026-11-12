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

export const toolActivityMessages = {
  '1 replacement': ['1 replacement', '1 处替换', '1 處取代'],
  'Recorded line {line}': ['Recorded line {line}', '已记录第 {line} 行', '已記錄第 {line} 行'],
  'The editor matched a normalized version of the requested text.': [
    'The editor matched a normalized version of the requested text.',
    '编辑器规范化请求文本后找到了匹配项。',
    '編輯器正規化請求文字後找到了相符項目。',
  ],
  'Delete file': ['Delete file', '删除文件', '刪除檔案'],
  'File changes': ['File changes', '文件变更', '檔案變更'],
  'No text changes': ['No text changes', '文本没有变化', '文字沒有變更'],
  'This action was not run.': [
    'This action was not run.',
    '这个操作没有执行。',
    '這個操作未執行。',
  ],
  Results: ['Results', '结果', '結果'],
  Skipped: ['Skipped', '已跳过', '已略過'],
  Skill: ['Skill', '技能', '技能'],
  'More lines are available.': [
    'More lines are available.',
    '还有更多行可读取。',
    '還有更多行可讀取。',
  ],
  'No output recorded.': ['No output recorded.', '没有记录到输出。', '沒有記錄到輸出。'],
  'Patch did not finish': ['Patch did not finish', '补丁未全部应用', '修補程式未完全套用'],
  'Files already changed': ['Files already changed', '已更改的文件', '已變更的檔案'],
  'Patch applied': ['Patch applied', '已应用补丁', '已套用修補程式'],
  'Reading details…': ['Reading details…', '正在读取详情…', '正在讀取詳細資料…'],
  'Waiting for tool result': ['Waiting for tool result', '等待工具结果', '等待工具結果'],
  'No additional details': ['No additional details', '没有更多详情', '沒有更多詳細資料'],
  'Background process': ['Background process', '后台进程', '背景程序'],
  Endpoint: ['Endpoint', '服务地址', '服務端點'],
  'Endpoint reachable': ['Endpoint reachable', '服务可达', '服務可連線'],
  'Endpoint unhealthy': ['Endpoint unhealthy', '服务异常', '服務異常'],
  'Endpoint health unknown': ['Endpoint health unknown', '服务状态未知', '服務狀態未知'],
  'Process output': ['Process output', '进程输出', '程序輸出'],
  'Process errors': ['Process errors', '进程错误输出', '程序錯誤輸出'],
  'Read image': ['Read image', '读取图片', '讀取圖片'],
  'Check background process': ['Check background process', '检查后台进程', '檢查背景程序'],
  'Read skill': ['Read skill', '读取技能', '讀取技能'],
  'No matching skills': ['No matching skills', '没有匹配的技能', '沒有相符的技能'],
  'Matching skills': ['Matching skills', '匹配的技能', '相符的技能'],
  '{shown} of {total} matching skills': [
    '{shown} of {total} matching skills',
    '已显示 {shown} 个，共 {total} 个匹配的技能',
    '已顯示 {shown} 個，共 {total} 個相符的技能',
  ],
  'More instructions are available.': [
    'More instructions are available.',
    '还有更多指引可读取。',
    '還有更多指引可讀取。',
  ],
  'Resource contents': ['Resource contents', '资源内容', '資源內容'],
  'The skill catalog changed.': [
    'The skill catalog changed.',
    '技能目录已变化。',
    '技能目錄已變更。',
  ],
  'Skill content unavailable': ['Skill content unavailable', '技能内容不可用', '技能內容無法使用'],
  'Ask you a question': ['Ask you a question', '向你提问', '向你提問'],
  'Question closed': ['Question closed', '提问已关闭', '提問已關閉'],
  'Question rejected': ['Question rejected', '提问被拒绝', '提問遭拒'],
  'Invalid question': ['Invalid question', '提问格式有误', '提問格式有誤'],
  'Question unavailable': ['Question unavailable', '暂时无法提问', '暫時無法提問'],
  'A new message closed the question.': [
    'A new message closed the question.',
    '收到新消息后结束提问。',
    '收到新訊息後結束提問。',
  ],
  'The response was stopped.': ['The response was stopped.', '回复已停止。', '回覆已停止。'],
  'The response ended.': ['The response ended.', '回复已结束。', '回覆已結束。'],
  'The question was cancelled.': ['The question was cancelled.', '提问已取消。', '提問已取消。'],
  'The question timed out.': ['The question timed out.', '提问已超时。', '提問已逾時。'],
  'The Host restarted.': ['The Host restarted.', 'Host 已重启。', 'Host 已重新啟動。'],
  'The provider disconnected.': [
    'The provider disconnected.',
    '提供商连接已断开。',
    '供應商連線已中斷。',
  ],
  'The question was closed.': ['The question was closed.', '提问已关闭。', '提問已關閉。'],
  'Use computer': ['Use computer', '操作电脑', '操作電腦'],
  'Reset computer session': ['Reset computer session', '重置电脑操作环境', '重設電腦操作環境'],
  'Computer controls need to be reset.': [
    'Computer controls need to be reset.',
    '需要重置电脑操作环境。',
    '需要重設電腦操作環境。',
  ],
  'Computer controls reset.': [
    'Computer controls reset.',
    '电脑操作环境已重置。',
    '電腦操作環境已重設。',
  ],
  'Computer output': ['Computer output', '电脑操作结果', '電腦操作結果'],
} as const;
