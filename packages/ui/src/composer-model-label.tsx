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

import { useLayoutEffect, useRef, useState } from 'react';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Visual label only; the owning Selector/Button retains the full accessible name. */
export function ComposerModelLabel({ text }: { text: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const ellipsis = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState({ source: text, label: text });

  useLayoutEffect(() => {
    const element = root.current;
    const full = measure.current;
    const marker = ellipsis.current;
    if (!element || !full || !marker) return;
    let disposed = false;
    const offsets = [0];
    for (const part of segmenter.segment(text)) offsets.push(part.index + part.segment.length);
    const update = () => {
      if (disposed || !element.clientWidth) return;
      const width = element.getBoundingClientRect().width;
      const node = full.firstChild;
      if (!node) return;
      const range = document.createRange();
      const measurePart = (start: number, end: number) => {
        range.setStart(node, start);
        range.setEnd(node, end);
        return range.getBoundingClientRect().width;
      };
      let label = text;
      if (measurePart(0, text.length) > width) {
        const markerWidth = marker.getBoundingClientRect().width;
        const count = offsets.length - 1;
        let low = 0;
        let high = count - 1;
        // Balance the retained graphemes; measure the actual font and preserve
        // complete characters rather than clipping either half with CSS.
        while (low < high) {
          const keep = Math.ceil((low + high) / 2);
          const startEnd = offsets[Math.ceil(keep / 2)]!;
          const endStart = offsets[count - Math.floor(keep / 2)]!;
          const needed = measurePart(0, startEnd) + markerWidth + measurePart(endStart, text.length);
          if (needed <= width) low = keep;
          else high = keep - 1;
        }
        label = `${text.slice(0, offsets[Math.ceil(low / 2)])}…${text.slice(offsets[count - Math.floor(low / 2)])}`;
      }
      setFitted((current) => current.source === text && current.label === label
        ? current : { source: text, label });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    void document.fonts?.ready.then(update);
    document.fonts?.addEventListener('loadingdone', update);
    return () => {
      disposed = true;
      observer?.disconnect();
      document.fonts?.removeEventListener('loadingdone', update);
    };
  }, [text]);

  return (
    <span ref={root} className="maka-composer-model-label" dir="ltr" title={text} aria-hidden="true">
      <span ref={measure} className="maka-composer-model-label-measure">{text}</span>
      <span ref={ellipsis} className="maka-composer-model-label-ellipsis">…</span>
      <span className="maka-composer-model-label-text">{fitted.source === text ? fitted.label : text}</span>
    </span>
  );
}
