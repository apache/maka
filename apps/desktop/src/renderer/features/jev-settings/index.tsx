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

import { useRef, useState, type ReactNode } from 'react';
import type { AppSettings, UpdateAppSettingsInput, UpdateAppSettingsResult } from '@maka/core/settings';
import { useMountedRef, useToast, useUiLocale } from '@maka/ui';

const JEV_COPY = {
  'zh-CN': {
    advanced: '高级设置', title: 'Jev 辅助决策',
    help: '使用 TypeSafe Jev 辅助 WorkHub 的意图分类和工作路由。会发送当前消息与候选工作摘要；对话、执行和标题仍使用原模型。',
    key: 'TypeSafe API Key', saved: '已保存密钥；输入新值以替换',
    save: '保存密钥', saving: '正在保存…', clear: '移除密钥',
    behavior: '判断不确定时请求澄清；服务不可用时使用原有路由。',
    failure: 'Jev 设置保存失败，请重试。',
  },
  'zh-TW': {
    advanced: '進階設定', title: 'Jev 輔助決策',
    help: '使用 TypeSafe Jev 輔助 WorkHub 的意圖分類和工作路由。會傳送目前訊息與候選工作摘要；對話、執行和標題仍使用原模型。',
    key: 'TypeSafe API Key', saved: '已儲存金鑰；輸入新值以替換',
    save: '儲存金鑰', saving: '正在儲存…', clear: '移除金鑰',
    behavior: '判斷不確定時請求釐清；服務無法使用時採用原有路由。',
    failure: 'Jev 設定儲存失敗，請重試。',
  },
  en: {
    advanced: 'Advanced settings', title: 'Jev assisted decisions',
    help: 'Use TypeSafe Jev for WorkHub intent classification and work routing. Sends the current message and candidate work summaries. Conversation, execution, and titles keep their original models.',
    key: 'TypeSafe API Key', saved: 'Key saved; enter a new value to replace it',
    save: 'Save key', saving: 'Saving…', clear: 'Remove key',
    behavior: 'Uncertain decisions ask for clarification; service failures use the existing router.',
    failure: 'Could not save Jev settings. Please try again.',
  },
};

export function JevSettingsController(props: {
  isInteractive: boolean;
  onUpdate(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult>;
  children(state: {
    copy: typeof JEV_COPY.en;
    key: string;
    setKey(value: string): void;
    saving: boolean;
    save(patch: Partial<AppSettings['jev']>): Promise<void>;
  }): ReactNode;
}) {

  const locale = useUiLocale();
  const copy = JEV_COPY[locale];
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useMountedRef();
  const toast = useToast();
  async function save(patch: Partial<AppSettings['jev']>) {
    if (!props.isInteractive || pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      await props.onUpdate({ jev: patch });
      if (mounted.current && patch.apiKey !== undefined) setKey('');
    } catch {
      if (mounted.current) toast.error(copy.failure);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return props.children({ copy, key, setKey, saving, save });
}
