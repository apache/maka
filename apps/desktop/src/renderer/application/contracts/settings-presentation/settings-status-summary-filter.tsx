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

import { Button } from '@astryxdesign/core';

type SummaryTone = 'success' | 'warning' | 'destructive' | 'neutral';

export type SettingsStatusSummaryOption<Value extends string> = {
  value: Value;
  label: string;
  count: number;
  tone: SummaryTone;
};

export function SettingsStatusSummaryFilter<Value extends string>(props: {
  value: Value | null;
  options: readonly SettingsStatusSummaryOption<Value>[];
  label: string;
  optionLabel(option: SettingsStatusSummaryOption<Value>, selected: boolean): string;
  onChange(value: Value | null): void;
}) {
  return (
    <div className="settingsHealthSummaryLine settingsStatusSummaryFilters" role="group" aria-label={props.label}>
      {props.options.map((option) => {
        const selected = props.value === option.value;
        return (
          <Button
            key={option.value}
            className="settingsStatusSummaryFilter"
            variant="ghost"
            size="sm"
            data-tone={option.count > 0 ? option.tone : 'neutral'}
            aria-pressed={selected}
            label={props.optionLabel(option, selected)}
            isDisabled={option.count === 0}
            onClick={() => props.onChange(selected ? null : option.value)}
          >
            {option.label} {option.count}
          </Button>
        );
      })}
    </div>
  );
}
