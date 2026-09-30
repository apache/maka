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

import { inspect } from 'node:util';
export default async function* report(events) {
  for await (const event of events) {
    if (event.type === 'test:summary')
      yield JSON.stringify({ type: event.type, data: event.data }) + '\n';
    if (event.type === 'test:fail')
      yield JSON.stringify({
        type: event.type,
        name: event.data.name,
        file: event.data.file,
        error: inspect(event.data.details.error, { depth: 5 }),
        failureType: event.data.details.error?.failureType,
      }) + '\n';
    if (event.type === 'test:stderr')
      yield JSON.stringify({ type: event.type, message: event.data.message }) + '\n';
  }
}
