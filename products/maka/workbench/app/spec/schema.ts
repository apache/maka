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

import { defineSchema, type BuiltInAction } from '@json-render/core';

export const specBuiltInActions: BuiltInAction[] = [
  {
    name: 'setState',
    description:
      'Set a value in the state model at the given JSON Pointer statePath. Params: { statePath: string, value: unknown }',
  },
  {
    name: 'pushState',
    description:
      'Append an item to an array in state. Params: { statePath: string, value: unknown, clearStatePath?: string }. Value may contain { "$state": "/path" } refs and "$id" for unique IDs.',
  },
  {
    name: 'removeState',
    description:
      'Remove an item from an array in state by index. Params: { statePath: string, index: number }',
  },
  {
    name: 'toggleState',
    description:
      'Flip a boolean value in state at the given JSON Pointer statePath. Params: { statePath: string }',
  },
  {
    name: 'resetState',
    description:
      'Restore initial /state values, or restore a single subtree when statePath is given. Params: { statePath?: string }',
  },
  {
    name: 'validateForm',
    description:
      'Validate all registered form fields with checks and write { valid: boolean, errors: Record<string, string[]> } to statePath (defaults to /formValidation). Params: { statePath?: string }',
  },
  {
    name: 'copyText',
    description: 'Copy text to the clipboard. Params: { text: string }',
  },
];

export const specDefaultRules: string[] = [
  'CLIENT-ONLY BOUNDARY: Generated UI runs strictly locally in the conversation stream and NEVER sends messages, prompts, or RPC calls back to the Agent or Host. Use ONLY the built-in client actions (setState, pushState, removeState, toggleState, resetState, validateForm, copyText); never invent server or agent actions.',
  'CRITICAL INTEGRITY CHECK: Every key referenced in an element\'s "children" or "slots" MUST exist in "elements". Emit child elements alongside or immediately after their parent so no branch is left dangling.',
  'REQUIRED FIELDS: Every element MUST include "type", "props", and "children" (use "children": [] on leaf elements).',
  'FIELD PLACEMENT: "visible", "on", "repeat", and "watch" belong on the ELEMENT object (siblings of type/props/children), NEVER inside "props".',
  'STATE & REPEAT: Put initial state at top-level "/state" patches. For arrays of items, use "repeat": { "statePath": "/items", "key": "id" } on a container element (or { "statePath": { "$item": "subItems" } } inside an outer repeat) with { "$item": "field" }, { "$index": true }, and { "$bindItem": "field" } inside repeated children.',
  'NATIVE LAYOUT & VISUALS: Maka renders natively on both Desktop (GPU) and Terminal (TUI) without HTML/CSS/WebView. Rely on Stack, Grid, Card, Tabs, Table, and native chart components with clean hierarchy and realistic data rather than raw markup.',
];

export const specSchema = defineSchema(
  (s) => ({
    spec: s.object({
      root: s.string(),
      elements: s.record(
        s.object({
          type: s.ref('catalog.components'),
          props: s.propsOf('catalog.components'),
          children: { ...s.array(s.string()), ...s.optional() },
          slots: { ...s.record(s.array(s.string())), ...s.optional() },
          visible: { ...s.any(), ...s.optional() },
          on: { ...s.any(), ...s.optional() },
          repeat: { ...s.any(), ...s.optional() },
          watch: { ...s.any(), ...s.optional() },
        }),
      ),
      state: { ...s.any(), ...s.optional() },
    }),
    catalog: s.object({
      components: s.map({
        props: s.zod(),
        slots: s.array(s.string()),
        events: s.array(s.string()),
        description: s.string(),
        example: s.any(),
      }),
    }),
  }),
  {
    builtInActions: specBuiltInActions,
    defaultRules: specDefaultRules,
  },
);
