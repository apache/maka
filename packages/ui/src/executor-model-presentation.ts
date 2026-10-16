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

import { THINKING_LEVELS } from '@maka/core/model-thinking';
import type { ExecutorCatalogEntry, ExecutorModelGroup } from '@maka/core/executor-catalog';

export function executorModelGroup(entry: ExecutorCatalogEntry, modelId: string | undefined): ExecutorModelGroup | undefined {
  return entry.modelGroups?.find(group => group.variants.some(variant => variant.modelId === modelId));
}

/** Choose the highest supported intensity using the catalog's opaque model ID. */
export function highestExecutorModelVariant(group: ExecutorModelGroup): string | undefined {
  return group.variants.reduce<ExecutorModelGroup['variants'][number] | undefined>((highest, variant) =>
    !highest || THINKING_LEVELS.indexOf(variant.level) > THINKING_LEVELS.indexOf(highest.level) ? variant : highest,
  undefined)?.modelId;
}
