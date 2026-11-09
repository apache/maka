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
import type { Row, View } from '../shared/plugin.js';
const action = z.object({
  id: z.string().max(150),
  title: z.string().max(160),
  data: z.unknown().optional(),
  confirm: z.string().max(1000).optional(),
  form: z
    .object({
      title: z.string(),
      fields: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            type: z.enum(['text', 'textarea', 'checkbox']).optional(),
            required: z.boolean().optional(),
            maxLength: z.number().max(100000).optional(),
          }),
        )
        .max(30),
      values: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
      draftKey: z.string().optional(),
    })
    .optional(),
});
const icon = z.union([
  z.enum([
    'browser',
    'screenshot',
    'application',
    'calculator',
    'link',
    'snippet',
    'clipboard',
    'extension',
    'search',
    'star',
  ]),
  z
    .string()
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
    .max(128 * 1024)
    .transform((value) => value as `data:image/png;base64,${string}`),
]);
const row = z.object({
  icon: icon.optional(),
  id: z.string().min(1).max(4096),
  name: z.string().max(100000),
  kind: z.string().max(100).optional(),
  keywords: z.string().max(100000).optional(),
  detail: z.string().max(100000).optional(),
  image: z
    .string()
    .startsWith('data:image/png;base64,')
    .max(6 * 1024 * 1024)
    .optional(),
  actions: z.array(action).max(30),
  featured: z.boolean().optional(),
  persistable: z.boolean().optional(),
});
const permissions = [
  'web.run',
  'web.connect',
  'browser.tabs.read',
  'browser.tabs.manage',
  'browser.tabs.connect',
  'screenshots.capture',
  'screenshots.pin',
  'assistant.open',
  'model.rank',
  'applications.list',
  'system.open',
  'system.reveal',
  'clipboard.read',
  'clipboard.write',
  'clipboard.watch',
  'paste',
  'text.transliterate',
] as const;
export const manifestSchema = z.object({
  web: z
    .object({
      runtime: z.literal('opencli'),
      commands: z
        .array(
          z
            .object({
              id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/),
              site: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
              command: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
              domain: z
                .string()
                .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)
                .max(253),
              access: z.literal('read'),
              request: z
                .object({
                  origin: z
                    .string()
                    .url()
                    .refine((value) => {
                      const u = new URL(value);
                      return (
                        u.protocol === 'https:' && u.origin === value && !u.username && !u.password
                      );
                    }),
                  path: z
                    .string()
                    .regex(/^\/[a-zA-Z0-9_/-]+$/)
                    .max(300),
                  params: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)).max(30),
                })
                .strict()
                .optional(),
            })
            .strict()
            .refine(
              (command) =>
                !command.request ||
                new URL(command.request.origin).hostname === command.domain ||
                new URL(command.request.origin).hostname.endsWith('.' + command.domain),
              'Request origin must belong to declared domain',
            ),
        )
        .min(1)
        .max(30)
        .refine(
          (items) => new Set(items.map((item) => item.id)).size === items.length,
          'Duplicate web command ID',
        ),
    })
    .strict()
    .optional(),
  locales: z
    .partialRecord(
      z.enum(['en', 'zh-CN']),
      z
        .object({
          name: z.string().max(160).optional(),
          description: z.string().max(1000).optional(),
          commands: z
            .record(
              z.string().max(150),
              z.object({
                name: z.string().max(160).optional(),
                kind: z.string().max(100).optional(),
                actions: z.record(z.string().max(150), z.string().max(160)).optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    )
    .optional(),
  icon: icon.optional(),
  apiVersion: z.literal(1),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{0,99}$/)
    .refine(
      (id) =>
        ![
          'host',
          'preferences',
          'input-history',
          'trace',
          'shortcuts',
          'extensions',
          'launcher-shortcut',
          'undelivered',
        ].includes(id),
      'Reserved host identifier',
    ),
  name: z.string().max(160),
  version: z.string().max(40),
  description: z.string().max(1000),
  permissions: z.array(z.enum(permissions)),
  commands: z.array(row).max(100),
  suggestions: z.boolean().optional(),
});
export const parseRows = (value: unknown): Row[] => z.array(row).max(2000).parse(value);
export const parseView = (value: unknown): View =>
  z
    .object({
      title: z.string(),
      rows: z.array(row).max(2000),
      actions: z.array(action).optional(),
      notice: z.string().optional(),
    })
    .parse(value);
