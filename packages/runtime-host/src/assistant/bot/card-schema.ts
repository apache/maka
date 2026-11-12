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

import { z } from 'zod';
import { isCardWebUrl } from '@maka/core/assistant-card';

const webUrl = z.string().max(2048).refine(isCardWebUrl, 'Use an HTTP(S) URL without credentials');
const action = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('link'), label: z.string().trim().min(1).max(40), value: webUrl })
    .strict(),
  z
    .object({
      kind: z.literal('reply'),
      label: z.string().trim().min(1).max(40),
      value: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
export const assistantCardSchema = z
  .object({
    type: z.enum(['recommendation', 'offer', 'delivery']),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(600).optional(),
    items: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            description: z.string().trim().min(1).max(1200).optional(),
            image: z
              .object({ url: webUrl, alt: z.string().trim().min(1).max(200) })
              .strict()
              .optional(),
            facts: z
              .array(
                z
                  .object({
                    label: z.string().trim().min(1).max(40),
                    value: z.string().trim().min(1).max(240),
                  })
                  .strict(),
              )
              .max(6)
              .optional(),
            actions: z.array(action).max(3).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
