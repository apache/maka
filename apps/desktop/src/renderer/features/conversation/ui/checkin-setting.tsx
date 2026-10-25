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

import type { ReactNode } from 'react';
import { Switch } from '@maka/ui';
import { useCheckinSetting } from '../services.js';

/** The check-in switch in Settings; the new-task screen reads the same state. */
export function CheckinEnableSwitch(props: { label: string }) {
  const setting = useCheckinSetting();
  return (
    <Switch
      label={props.label}
      isLabelHidden
      value={setting?.enabled ?? false}
      isDisabled={!setting}
      changeAction={(enabled) => setting?.setEnabled(enabled)}
    />
  );
}

/**
 * Its children show only while check-in is on with no default model to run
 * it. Settings is the one place that says so; the new-task screen stays quiet.
 */
export function CheckinDefaultModelHint(props: { hasDefaultModel: boolean; children: ReactNode }) {
  const setting = useCheckinSetting();
  return setting?.enabled && !props.hasDefaultModel ? props.children : null;
}
