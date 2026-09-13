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

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** A flow placeholder owns geometry, never scroll position or history reads. */
export function VirtualTranscriptTurn({
  turnId, scrollRef, enabled, required, initialHeight, onMeasure, children,
}: {
  turnId: string;
  scrollRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  required: boolean;
  initialHeight: number;
  onMeasure(id: string, height: number): void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const height = useRef(initialHeight);
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

  useEffect(() => {
    const node = root.current;
    if (!enabled || !mounted || !node) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
      if (next <= 0) return;
      height.current = next;
      measure.current(turnId, next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, mounted, turnId]);

  return <div ref={root} className="maka-transcript-turn"
    data-transcript-turn-id={turnId}
    data-turn-id={mounted ? undefined : turnId}
    data-virtual-placeholder={mounted ? undefined : ''}
    style={mounted ? undefined : { height: height.current, flexShrink: 0 }}
  >{mounted ? children : null}</div>;
}
