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

import { CodeBlock } from '@astryxdesign/core/CodeBlock';

// Rejected or deferred diagrams must not replace bounded parsing with an
// unbounded syntax-token DOM. Keep every source character and the copy action.
const MAX_HIGHLIGHTED_SVG_SOURCE_LENGTH = 20_000;
const plainSource = () => [];

export function SvgCodeSource({ code }: { code: string }) {
  return <CodeBlock code={code} language="svg"
    tokenizer={code.length > MAX_HIGHLIGHTED_SVG_SOURCE_LENGTH ? plainSource : undefined}
    highlightMode="spans" width="100%" isCollapsible collapsibleThreshold={10} />;
}
