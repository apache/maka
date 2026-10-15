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

import { useEffect, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Text, useUiLocale } from '@maka/ui';
import { defineShippedUiMessageCatalog, resolveUiMessageCatalog } from '@maka/core/ui-locale';
import type { DesktopStorageUpgradeStatus } from '../shared/runtime-host-identity.js';

const PHASES = ['preparing', 'rebuilding', 'verifying', 'opening'] as const;

const COPY = resolveUiMessageCatalog(defineShippedUiMessageCatalog<{
  title: string; detail: string; elapsed(seconds: number): string;
  preparing: string; rebuilding: string; verifying: string; opening: string;
  step(current: number, total: number): string;
}>()({
  'zh-CN': {
    title: '正在优化历史存储',
    detail: '此升级只需完成一次，完成后将自动打开。你可以关闭应用，下次打开时会重新检查并重试。',
    elapsed: (seconds) => `已等待 ${seconds} 秒`,
    preparing: '正在准备升级', rebuilding: '正在整理历史', verifying: '正在校验历史', opening: '正在打开历史',
    step: (current, total) => `第 ${current} 步，共 ${total} 步`,
  },
  'zh-TW': {
    title: '正在最佳化歷史儲存',
    detail: '此升級只需完成一次，完成後將自動開啟。你可以關閉應用程式，下次開啟時會重新檢查並重試。',
    elapsed: (seconds) => `已等待 ${seconds} 秒`,
    preparing: '正在準備升級', rebuilding: '正在整理歷史', verifying: '正在驗證歷史', opening: '正在開啟歷史',
    step: (current, total) => `第 ${current} 步，共 ${total} 步`,
  },
  en: {
    title: 'Optimizing history storage',
    detail: 'This is a one-time upgrade. Maka will open when it finishes. You can close the app; it will check and retry the upgrade next time.',
    elapsed: (seconds) => `Elapsed: ${seconds} seconds`,
    preparing: 'Preparing the upgrade', rebuilding: 'Rebuilding history', verifying: 'Checking history', opening: 'Opening history',
    step: (current, total) => `Step ${current} of ${total}`,
  },
}));

export function StorageUpgradeOverlay() {
  const copy = COPY[useUiLocale()];
  const [status, setStatus] = useState<DesktopStorageUpgradeStatus>({ active: false });
  const { active } = status;
  const phase = status.phase ?? 'preparing';
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const bridge = window.maka?.appWindow;
    if (!bridge?.getStorageUpgradeStatus || !bridge.subscribeStorageUpgrade) return;
    let mounted = true;
    let pushed = false;
    const stop = bridge.subscribeStorageUpgrade((status) => {
      pushed = true;
      if (mounted) setStatus(status);
    });
    void bridge.getStorageUpgradeStatus().then((status) => {
      if (mounted && !pushed) setStatus(status);
    }).catch(() => {});
    return () => { mounted = false; stop(); };
  }, []);
  useEffect(() => {
    setSeconds(0);
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  return <>
    <span data-maka-content-ready hidden />
    <Dialog isOpen onOpenChange={() => {}} purpose="required" width={440}>
      <DialogHeader title={copy.title} subtitle={copy.detail} />
      <div style={{ display: 'grid', gap: 16, padding: 24 }}>
        <ProgressBar isIndeterminate label={`${copy[phase]} · ${copy.step(PHASES.indexOf(phase) + 1, PHASES.length)}`} />
        <Text type="body">{copy.elapsed(seconds)}</Text>
      </div>
    </Dialog>
  </>;
}
