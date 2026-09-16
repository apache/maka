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

/** Native child views sit above DOM top-layer content, regardless of z-index. */
export function isNativeSurfaceOccluded(rect: DOMRect, document: Document): boolean {
  return Array.from(document.querySelectorAll(':popover-open:not(:empty), dialog[open]')).some((overlay) => {
    if (overlay.matches(':modal')) return true;
    const bounds = overlay.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.left < rect.right && bounds.right > rect.left && bounds.top < rect.bottom && bounds.bottom > rect.top;
  });
}
