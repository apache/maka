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

import { compileCronExpression } from '@maka/core/cron-expression';
import { SCHEDULED_TASK_CRON_MAX_CHARS } from '@maka/core/scheduled-task';

/** Converts the one released Plan Reminder grammar difference into current cron syntax. */
export function canonicalizeLegacyPlanReminderCronExpression(expression: string): string {
  if ([...expression].length > SCHEDULED_TASK_CRON_MAX_CHARS) throw invalidCron(expression);
  const parts = expression.split(' ');
  if (parts.length !== 5 || !compileCronExpression(expression).ok) throw invalidCron(expression);
  const canonical = parts
    .map((field) =>
      field
        .split(',')
        .map((token) => token.match(/^(\d+)\/\d+$/)?.[1] ?? token)
        .join(','),
    )
    .join(' ');
  if (!compileCronExpression(canonical).ok) throw invalidCron(expression);
  return canonical;
}

function invalidCron(expression: string): Error {
  return new Error(`Invalid legacy Plan Reminder cron expression: ${expression}`);
}
