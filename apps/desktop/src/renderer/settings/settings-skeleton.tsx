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

import { Skeleton } from '@astryxdesign/core';
import { useUiLocale } from '@maka/ui';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';

type SkeletonLine = { width: string; size?: 'lg' | 'sm' };

// 权限/健康快照页共用的骨架行预设：首行大号标题条，其余模拟段落行宽。
const SNAPSHOT_SKELETON_LINES: ReadonlyArray<SkeletonLine> = [
  { width: '38%', size: 'lg' },
  { width: '72%' },
  { width: '60%' },
  { width: '80%' },
];

// 带可访问性 label 的骨架行堆，供各设置页加载态共用，避免每页手写重复的 skeleton 标记。
export function SettingsSkeletonStack({
  label,
  lines = SNAPSHOT_SKELETON_LINES,
}: {
  label: string;
  lines?: ReadonlyArray<SkeletonLine>;
}) {
  return (
    <div className="settingsSkeletonStack" role="status" aria-busy="true" aria-label={label}>
      {lines.map((line, index) => (
        <Skeleton
          key={index}
          width={line.width}
          height={line.size === 'lg' ? 16 : line.size === 'sm' ? 9 : 12}
          radius="rounded"
          index={index}
        />
      ))}
    </div>
  );
}

export function SettingsSkeleton() {
  const copy = getSettingsSharedCopy(useUiLocale());
  return (
    <div className="settingsLoadingSkeleton" role="status" aria-busy="true" aria-label={copy.loading}>
      <div className="settingsSkeletonStack">
        <Skeleton width="38%" height={16} radius="rounded" index={0} />
        <Skeleton height={92} radius={3} index={1} />
        <Skeleton width="60%" height={9} radius="rounded" index={2} />
        <Skeleton width="85%" height={12} radius="rounded" index={3} />
        <Skeleton width="72%" height={12} radius="rounded" index={4} />
        <Skeleton width="48%" height={12} radius="rounded" index={5} />
      </div>
    </div>
  );
}
