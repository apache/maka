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

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** Mounts near the viewport; measured heights belong to the shared geometry ledger. */
export function VirtualTranscriptTurn({
  turnId, scrollRef, enabled, required, getHeight, onMeasure, children,
}: {
  turnId: string;
  scrollRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  required: boolean;
  getHeight(id: string): number;
  onMeasure(id: string, height: number): void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const measure = useRef(onMeasure);
  measure.current = onMeasure;
  const [nearby, setNearby] = useState(!enabled);
  const [retained, setRetained] = useState(false);
  const mounted = !enabled || required || nearby || retained;

  useEffect(() => {
    const node = root.current;
    const viewport = scrollRef.current;
    if (!enabled || !node || !viewport) return;
    const retainUserState = () => {
      const selection = node.ownerDocument.getSelection();
      // Removing a focused editor or a selection would destroy user state.
      setRetained(node.contains(node.ownerDocument.activeElement)
        || Boolean(selection && !selection.isCollapsed && selection.containsNode(node, true)));
    };
    const observer = new IntersectionObserver(([entry]) => {
      retainUserState();
      setNearby(entry.isIntersecting);
    }, { root: viewport, rootMargin: '800px 0px' });
    observer.observe(node);
    const afterFocus = () => queueMicrotask(retainUserState);
    node.addEventListener('focusout', afterFocus);
    node.ownerDocument.addEventListener('selectionchange', retainUserState);
    return () => {
      observer.disconnect();
      node.removeEventListener('focusout', afterFocus);
      node.ownerDocument.removeEventListener('selectionchange', retainUserState);
    };
  }, [enabled, scrollRef]);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    // An estimated shell cannot hold a reading anchor. Keep the same exclusion
    // through its first real layout: removing it in the mounting render lets
    // the browser choose the shell just as its explicit height becomes auto.
    node.style.overflowAnchor = enabled ? 'none' : '';
    if (!enabled || !mounted) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
      if (next <= 0) return;
      measure.current(turnId, next);
      node.style.overflowAnchor = 'auto';
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, mounted, turnId]);

  return <div ref={root} className="maka-transcript-turn"
    data-transcript-turn-id={turnId}
    data-turn-id={mounted ? undefined : turnId}
    data-virtual-placeholder={mounted ? undefined : ''}
    style={mounted ? undefined : { height: getHeight(turnId), flexShrink: 0 }}
  >{mounted ? children : null}</div>;
}
