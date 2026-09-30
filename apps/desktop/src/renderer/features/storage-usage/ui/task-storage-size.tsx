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

import { useEffect, useRef, useState } from 'react';
import { Text } from '@astryxdesign/core/Text';
import { formatBytes, useUiLocale } from '@maka/ui';
import type { SessionStorageUsage } from '@maka/runtime-host/protocol';
import { getStorageUsageCopy } from '../../../locales/storage-usage-copy.js';
import { sessionStorageBytes } from '../model/session-storage-loader.js';
import { useOptionalSessionStorageLoader } from '../services-context.js';

/** Starts measuring slightly before a row scrolls in, so its size is ready on arrival. */
const VISIBILITY_MARGIN = '200px 0px';

/**
 * A task's measured size, or nothing while unknown. Never a guess.
 *
 * The archived-task list is not virtualized, so every matching row mounts. A
 * row asks for its size only once it scrolls into view; rows never seen are
 * never measured. The shared loader batches the rows that become visible
 * together into bounded Host requests, one at a time.
 */
export function TaskStorageSize(props: { readonly sessionId: string }) {
  const loader = useOptionalSessionStorageLoader();
  const locale = useUiLocale();
  const anchor = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [usage, setUsage] = useState<SessionStorageUsage | undefined>(undefined);

  useEffect(() => {
    const element = anchor.current;
    if (!loader || !element || visible) return;
    // Without an observer (a non-browser host) there is no scroll to wait for.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setVisible(true);
        }
      },
      { root: scrollParent(element), rootMargin: VISIBILITY_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [loader, visible]);

  useEffect(() => {
    if (!loader || !visible) return;
    let current = true;
    setUsage(undefined);
    void loader.load(props.sessionId).then((measured) => {
      if (current) setUsage(measured);
    });
    return () => {
      current = false;
    };
  }, [loader, props.sessionId, visible]);

  return (
    <span ref={anchor}>
      {usage ? (
        <Text type="supporting" size="sm" color="secondary">
          {getStorageUsageCopy(locale).taskSize(formatBytes(sessionStorageBytes(usage), locale))}
        </Text>
      ) : null}
    </span>
  );
}

/**
 * The nearest scrolling ancestor. `rootMargin` only prefetches relative to the
 * observer root, and the Settings list scrolls inside its own container rather
 * than the viewport.
 */
function scrollParent(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = node.ownerDocument.defaultView?.getComputedStyle?.(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}
