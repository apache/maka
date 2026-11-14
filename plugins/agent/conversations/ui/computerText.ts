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

import { languageIndex } from '../../../shared/locale';
import { currentLocale } from '../../../../products/maka/workbench/app/locale';

const copy = {
  Computer: ['电脑', '電腦'],
  Pinned: ['已固定', '已固定'],
  'Selected target': ['已选画面', '已選畫面'],
  'Following agent': ['跟随 Agent', '跟隨 Agent'],
  'Pin target': ['固定画面', '固定畫面'],
  'Unpin target': ['取消固定', '取消固定'],
  'Follow agent': ['跟随 Agent', '跟隨 Agent'],
  'Show live view': ['显示实时画面', '顯示即時畫面'],
  'Hide live view': ['隐藏实时画面', '隱藏即時畫面'],
  'Expanded live view': ['放大的实时画面', '放大的即時畫面'],
  'Close expanded view': ['关闭放大画面', '關閉放大畫面'],
  'Hiding the view does not stop the agent.': [
    '隐藏画面不会停止 Agent。',
    '隱藏畫面不會停止 Agent。',
  ],
  'Retry live view': ['重试实时画面', '重試即時畫面'],
  'Live view unavailable': ['实时画面不可用', '即時畫面無法使用'],
  'Waiting for live frame…': ['等待实时画面…', '等待即時畫面…'],
} as const;
export function computerText(key: keyof typeof copy): string {
  const language = languageIndex(currentLocale());
  return language === 1 ? copy[key][0] : language === 2 ? copy[key][1] : key;
}
