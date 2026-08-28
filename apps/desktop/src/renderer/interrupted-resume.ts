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

export interface InterruptedResumeTurn {
  turnId: string;
  status: string;
  errorClass?: string;
  /** Tool activity already has a durable result in the rendered Turn. */
  tools?: readonly { status: string }[];
}

export function latestInterruptedResumeTurnId(
  turns: readonly InterruptedResumeTurn[],
): string | undefined {
  const latestTurn = turns.at(-1);
  if (latestTurn?.status !== 'failed') return undefined;
  const errorClass = latestTurn.errorClass?.toLowerCase();
  if (errorClass === 'app_restarted') return latestTurn.turnId;
  if (
    errorClass?.includes('timeout') &&
    latestTurn.tools !== undefined &&
    latestTurn.tools.length > 0 &&
    latestTurn.tools.every((tool) => tool.status === 'completed')
  ) {
    return latestTurn.turnId;
  }
  return undefined;
}
