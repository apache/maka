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

import { INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID } from '../composition-identity.js';
import type { RuntimeHostCompositionFactory } from './host-kernel.js';

const COMPOSITION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export interface HostCompositionDescriptor {
  readonly id: string;
  readonly revision: string;
}

export interface RuntimeHostCompositionSource {
  readonly descriptor: HostCompositionDescriptor;
  readonly create: RuntimeHostCompositionFactory;
}

export function defineRuntimeHostComposition(
  descriptor: HostCompositionDescriptor,
  create: RuntimeHostCompositionFactory,
): RuntimeHostCompositionSource {
  return Object.freeze({
    descriptor: normalizeHostCompositionDescriptor(descriptor),
    create,
  });
}

export function defineInteractiveRuntimeHostComposition(
  create: RuntimeHostCompositionFactory,
): RuntimeHostCompositionSource {
  return defineRuntimeHostComposition(INTERACTIVE_HOST_COMPOSITION_DESCRIPTOR, create);
}

export function normalizeHostCompositionDescriptor(
  descriptor: HostCompositionDescriptor,
): HostCompositionDescriptor {
  if (!COMPOSITION_ID_PATTERN.test(descriptor.id) || descriptor.id.length > 128) {
    throw new TypeError('Runtime Host composition id is invalid');
  }
  if (
    descriptor.revision.length === 0 ||
    descriptor.revision.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(descriptor.revision)
  ) {
    throw new TypeError('Runtime Host composition revision is invalid');
  }
  return Object.freeze({
    id: descriptor.id,
    revision: descriptor.revision,
  });
}

export const INTERACTIVE_HOST_COMPOSITION_DESCRIPTOR = normalizeHostCompositionDescriptor({
  id: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  revision: '3',
});
