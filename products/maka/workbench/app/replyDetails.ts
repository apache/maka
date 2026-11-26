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

import { formatDuration } from './duration';
import type { Row } from './history';
import { tr } from './locale';
import { cacheHitRate } from './TurnUsage';

export function replyMetrics(row: Pick<Row, 'model' | 'replyInfo' | 'timing'>) {
  const info = row.replyInfo;
  const model = row.model;
  const name =
    info?.modelId ??
    (model?.kind === 'native' ? (model.reportedModelId ?? model.requestedModelId) : model?.modelId);
  const timing = row.timing;
  const elapsed =
    info?.durationMs ??
    (timing?.finished && timing.finished.at >= timing.startedAt
      ? timing.finished.at - timing.startedAt
      : timing?.executorUsage?.durationMs);
  return { name, elapsed };
}

export function replyDetails(row: Row): string {
  const { name, elapsed } = replyMetrics(row);
  const timing = row.timing;
  const tokens = row.replyInfo?.usage ?? timing?.modelTokens;
  const cache = timing?.promptCache;
  return [
    name,
    elapsed == null ? '' : formatDuration(elapsed, 'tenths'),
    tokens?.input_tokens == null ? '' : tr('{count} input tokens', { count: tokens.input_tokens }),
    tokens?.output_tokens == null
      ? ''
      : tr('{count} output tokens', { count: tokens.output_tokens }),
    cache && tr('Cache hit {rate}', { rate: cacheHitRate(cache) }),
  ]
    .filter(Boolean)
    .join(' · ');
}
