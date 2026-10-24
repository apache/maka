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

import { HStack, StatusDot, Text } from '@astryxdesign/core';
import { dotForStatus, type StatusSemantic } from './status-vocabulary.js';

/**
 * A row's trailing status as words. Only states that ask for a look get a dot;
 * the dot repeats the words, so it is hidden from assistive tech.
 */
export function StatusLabel(props: { status: StatusSemantic; label: string }) {
  const hasDot = props.status === 'attention' || props.status === 'error' || props.status === 'active';
  return (
    <HStack gap={2} vAlign="center" wrap="nowrap">
      {hasDot ? (
        <span aria-hidden="true" className="maka-status-label-dot">
          <StatusDot variant={dotForStatus(props.status)} label={props.label} isPulsing={props.status === 'active'} />
        </span>
      ) : null}
      <Text color="secondary">{props.label}</Text>
    </HStack>
  );
}
