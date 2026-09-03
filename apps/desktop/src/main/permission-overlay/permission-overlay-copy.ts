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

/**
 * Copy for the drag-to-grant card.
 *
 * It lives in main, not the renderer, because the card is a standalone
 * overlay page with no access to the renderer's locale context — main
 * resolves the locale and ships the finished strings in the show payload.
 */

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { DragGrantPermissionId } from './permission-overlay-controller.js';

export interface PermissionOverlayCopy {
  /** Headline, e.g. "Drag Maka into the list to allow Accessibility". */
  headline(appName: string): string;
  /** The manual route, so the card is never the only way through. */
  fallback: string;
  /** Shown once the grant lands. */
  granted: string;
  dismiss: string;
  dragHint: string;
  /**
   * Screen Recording only: macOS caches the previous denial, so a freshly
   * granted app often keeps reading as denied until it restarts. There is
   * no API fix — the honest answer is to say so.
   */
  restartHint?: string;
  /** Shown instead of the drag affordance when there is no .app to drag. */
  noBundle: string;
}

type Catalog = UiCatalog<Record<DragGrantPermissionId, PermissionOverlayCopy>>;

const COPY: Catalog = {
  zh: {
    accessibility: {
      headline: (appName) => `把 ${appName} 拖到上面的列表里，即可开启「辅助功能」`,
      fallback: '也可以在系统设置里点 + 号，从「应用程序」中选择本 App。',
      granted: '辅助功能已开启',
      dismiss: '关闭',
      dragHint: '拖我',
      noBundle: '当前不是以 .app 方式运行，无法拖拽。请在系统设置里手动添加。',
    },
    screen_recording: {
      headline: (appName) => `把 ${appName} 拖到上面的列表里，即可开启「屏幕录制」`,
      fallback: '也可以在系统设置里点 + 号，从「应用程序」中选择本 App。',
      granted: '屏幕录制已开启',
      dismiss: '关闭',
      dragHint: '拖我',
      restartHint: '若仍显示未授权，需要重启 App —— macOS 会缓存上一次的拒绝结果。',
      noBundle: '当前不是以 .app 方式运行，无法拖拽。请在系统设置里手动添加。',
    },
  },
  en: {
    accessibility: {
      headline: (appName) => `Drag ${appName} into the list above to allow Accessibility`,
      fallback: 'Or click + in System Settings and pick the app from Applications.',
      granted: 'Accessibility enabled',
      dismiss: 'Close',
      dragHint: 'Drag me',
      noBundle: 'Not running from a .app bundle, so there is nothing to drag. Add it manually in System Settings.',
    },
    screen_recording: {
      headline: (appName) => `Drag ${appName} into the list above to allow Screen Recording`,
      fallback: 'Or click + in System Settings and pick the app from Applications.',
      granted: 'Screen Recording enabled',
      dismiss: 'Close',
      dragHint: 'Drag me',
      restartHint: 'If it still reads as denied, restart the app — macOS caches the previous denial.',
      noBundle: 'Not running from a .app bundle, so there is nothing to drag. Add it manually in System Settings.',
    },
  },
  ko: {
    accessibility: {
      headline: (appName) => `${appName}을(를) 위 목록으로 드래그하여 손쉬운 사용을 허용하세요`,
      fallback: '또는 시스템 설정에서 +를 클릭하고 응용 프로그램에서 앱을 선택하세요.',
      granted: '손쉬운 사용 활성화됨',
      dismiss: '닫기',
      dragHint: '여기로 드래그',
      noBundle: '.app 번들에서 실행되지 않아 드래그할 수 없습니다. 시스템 설정에서 수동으로 추가하세요.',
    },
    screen_recording: {
      headline: (appName) => `${appName}을(를) 위 목록으로 드래그하여 화면 기록을 허용하세요`,
      fallback: '또는 시스템 설정에서 +를 클릭하고 응용 프로그램에서 앱을 선택하세요.',
      granted: '화면 기록 활성화됨',
      dismiss: '닫기',
      dragHint: '여기로 드래그',
      restartHint: '여전히 거부됨으로 표시되면 앱을 다시 시작하세요. macOS가 이전 거부 결과를 캐시합니다.',
      noBundle: '.app 번들에서 실행되지 않아 드래그할 수 없습니다. 시스템 설정에서 수동으로 추가하세요.',
    },
  },
};

export function getPermissionOverlayCopy(
  locale: UiLocale,
  permission: DragGrantPermissionId,
): PermissionOverlayCopy {
  return COPY[locale][permission];
}
