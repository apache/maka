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

export function formatDuration(milliseconds: number, fractionalSeconds = false): string {
  const seconds =
    fractionalSeconds && milliseconds < 60_000
      ? Math.round(milliseconds / 100) / 10
      : Math.floor(milliseconds / 1000);
  if (seconds < 60) return fractionalSeconds ? `${seconds.toFixed(1)}s` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainderSeconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainderSeconds}s`;
}
