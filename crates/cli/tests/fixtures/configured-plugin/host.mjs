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

// Independent fixture for opaque configuration lifecycle; Board and WorkHub
// continue to exercise their own unchanged domain behavior.
export default async function activate(ctx, config) {
  if (typeof config?.greeting !== 'string') throw new Error('greeting must be a string');
  await ctx.tui.app(
    'greeting',
    {
      entry: 'configured-ui.mjs',
      async backend(request) {
        if (request.kind === 'read') return { greeting: config.greeting };
        return { kind: 'rejected', message: 'Greeting is read-only' };
      },
    },
    { title: { fallback: 'Greeting', translations: {} }, context: 'application' },
  );
}
