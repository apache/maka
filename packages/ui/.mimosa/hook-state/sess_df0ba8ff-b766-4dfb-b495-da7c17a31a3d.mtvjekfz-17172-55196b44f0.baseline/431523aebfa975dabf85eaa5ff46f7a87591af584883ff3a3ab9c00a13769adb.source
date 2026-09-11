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

import { FileCode, FileImage, FileText, FileType, Paperclip, type LucideIcon } from './icons.js';
import type { AttachmentRef } from '@maka/core/events';
import { Icon } from '@astryxdesign/core/Icon';

/** Per-kind lucide icon for attachment tokens. Replaces the
 *  emoji labels (🖼📄📘💻📎) with a consistent icon set. */
export const ATTACHMENT_KIND_ICON: Record<AttachmentRef['kind'], LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  doc: FileType,
  code: FileCode,
  other: Paperclip,
};

export function AttachmentKindIcon(props: { kind: AttachmentRef['kind']; className?: string }) {
  const AttachmentIcon = ATTACHMENT_KIND_ICON[props.kind];
  return <Icon icon={AttachmentIcon} size="sm" color="inherit" className={props.className} />;
}
