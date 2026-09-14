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

import { Button } from '@astryxdesign/core/Button';
import { useUiLocale } from '@maka/ui';
import { computerHistoryCopy } from './computer-history-copy.js';

export function ComputerHistoryKeywords({ keywords, onSearch }: {
  keywords?: readonly string[];
  onSearch(keyword: string): void;
}) {
  const copy = computerHistoryCopy(useUiLocale());
  if (!keywords?.length) return null;
  return <div className="computer-history-keywords" role="group" aria-label={copy.keywords}>
    {keywords.map((keyword, index) => <Button
      key={`${index}:${keyword}`} variant="ghost" size="sm" label={keyword}
      aria-label={`${copy.searchKeyword}: ${keyword}`} onClick={() => onSearch(keyword)}
    />)}
  </div>;
}
