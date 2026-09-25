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

import type {
  ExecutorCatalogEntry,
  ExecutorModelChoice,
  ExecutorModelGroup,
} from '@maka/core/executor-catalog';
import { THINKING_LEVELS, type ThinkingLevel } from '@maka/core/model-thinking';

/** Official ACP 1.1.1 labels encode intensity; IDs are opaque (e.g. gemini-pro-agent). */
export function describeAntigravityModels(
  models: readonly ExecutorModelChoice[],
): Pick<ExecutorCatalogEntry, 'models' | 'modelGroups'> {
  const families = new Map<string, Array<{ modelId: string; level: ThinkingLevel }>>();
  const unrecognized = new Set<string>();
  for (const model of models) {
    const match = /^(Gemini \d+(?:\.\d+)? (?:Flash|Pro)) \((High|Medium|Low)\)$/.exec(model.name);
    if (!match) {
      // A bare or unfamiliar variant of the same family makes grouping ambiguous.
      const family = /^(Gemini \d+(?:\.\d+)? (?:Flash|Pro))(?:$|[ (])/.exec(model.name)?.[1];
      if (family) unrecognized.add(family);
      continue;
    }
    const variants = families.get(match[1]!) ?? [];
    variants.push({ modelId: model.id, level: match[2]!.toLowerCase() as ThinkingLevel });
    families.set(match[1]!, variants);
  }
  const modelGroups: ExecutorModelGroup[] = [];
  for (const [name, variants] of families) {
    if (
      unrecognized.has(name) ||
      variants.length < 2 ||
      new Set(variants.map((v) => v.level)).size !== variants.length
    )
      continue;
    modelGroups.push({
      id: name,
      name,
      variants: [...variants].sort(
        (a, b) => THINKING_LEVELS.indexOf(a.level) - THINKING_LEVELS.indexOf(b.level),
      ),
    });
  }
  return {
    models: models.map((model) =>
      /^Gemini(?: |$)/.test(model.name) ? { ...model, providerType: 'google' } : model,
    ),
    modelGroups,
  };
}
