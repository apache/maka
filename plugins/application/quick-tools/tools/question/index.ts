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

import type { Plugin } from '../../shared/plugin';
import { qt } from '../../shared/i18n';

export interface QuickQuestionEntry {
  lastQuestion(): string | undefined;
  resume(): void;
}

export function quickQuestionPlugin(entry: QuickQuestionEntry): Plugin {
  return {
    search(query) {
      const previous = entry.lastQuestion();
      if (!previous || query.trim()) return [];
      return [
        {
          id: 'resume',
          name: qt('继续上次提问'),
          kind: qt('快问'),
          featured: true,
          persistable: false,
          actions: [{ id: 'resume', title: qt('继续上次提问') }],
        },
      ];
    },
    run(action) {
      if (action !== 'resume' || !entry.lastQuestion()) throw Error(qt('没有匹配结果'));
      entry.resume();
    },
  };
}
