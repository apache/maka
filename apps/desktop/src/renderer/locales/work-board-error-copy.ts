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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { WorkBoardErrorCode } from '../../shared/work-board-ipc.js';

type WorkBoardErrorCopy = Record<WorkBoardErrorCode, string>;

const WORK_BOARD_ERROR_COPY = {
  'zh-CN': {
    invalid_input: '这项操作无效，请检查后重试',
    not_found: '这条事项已不存在',
    operation_conflict: '这条事项已发生变化，请刷新后重试',
    corrupt_record: '这条事项暂时无法读取',
    must_archive_first: '请先归档，再删除这条事项',
    unknown: '操作失败，请稍后重试',
  },
  'zh-TW': {
    invalid_input: '這項操作無效，請檢查後重試',
    not_found: '這則事項已不存在',
    operation_conflict: '這則事項已發生變化，請重新整理後重試',
    corrupt_record: '這則事項暫時無法讀取',
    must_archive_first: '請先封存，再刪除這則事項',
    unknown: '操作失敗，請稍後重試',
  },
  en: {
    invalid_input: 'This action is invalid. Check it and try again.',
    not_found: 'This item no longer exists.',
    operation_conflict: 'This item changed. Refresh and try again.',
    corrupt_record: 'This item cannot be read right now.',
    must_archive_first: 'Archive this item before deleting it.',
    unknown: 'The action failed. Try again later.',
  },
} satisfies UiCatalog<WorkBoardErrorCopy>;

export function getWorkBoardErrorCopy(locale: UiLocale): WorkBoardErrorCopy {
  return WORK_BOARD_ERROR_COPY[locale];
}
