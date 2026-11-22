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

import { signal } from 'nsh';

type ViewportPresentation = {
  lineHeight: number;
  textTerminal: boolean;
  totalRows(): number;
  height(): number;
  rows(): number;
  scrollTo(y: number): void;
  scrollToEnd(): void;
};

export function createTerminalViewport() {
  const position = { x: 0, y: 0 };
  const historyTop = signal<number | null>(null);
  return {
    position,
    historyTop: () => historyTop(),
    // Browsing survives remounts; pending native gestures belong to one presentation.
    attach(options: ViewportPresentation) {
      let scrollInput: 'idle' | 'pending' | 'dragging' = 'idle';
      const scrollEnd = () =>
        Math.max(0, options.totalRows() * options.lineHeight - options.height());
      const showHistory = (y: number) =>
        historyTop.set(Math.floor(Math.max(0, y) / options.lineHeight));
      const pageHistory = (direction: -1 | 1) => {
        const end = scrollEnd();
        const start = historyTop() === null ? end : position.y;
        const y = Math.min(
          end,
          Math.max(0, start + direction * options.rows() * options.lineHeight),
        );
        scrollInput = 'idle';
        position.y = y;
        if (y >= end) historyTop.set(null);
        else {
          showHistory(y);
          options.scrollTo(y);
        }
      };
      return {
        page: pageHistory,
        follow() {
          if (historyTop() === null && scrollInput !== 'dragging') options.scrollToEnd();
        },
        onScrollIntent: ({
          intent,
          delta,
        }: {
          intent: 'start' | 'end' | 'scroll';
          delta?: number;
        }) => {
          if (
            intent === 'end' ||
            ((delta ?? 0) > 0 && historyTop() !== null && position.y >= scrollEnd() - 1)
          )
            historyTop.set(null);
          else if (scrollInput !== 'dragging') scrollInput = 'pending';
        },
        onScrollDragStart: ({ offset }: { offset: { y: number } }) => {
          position.y = offset.y;
          scrollInput = 'dragging';
        },
        onScrollEnd: ({ offset }: { offset: { y: number } }) => {
          if (scrollInput === 'idle') return;
          // The final offset may settle before its throttled onScroll arrives.
          scrollInput = offset.y === position.y ? 'idle' : 'pending';
          if (scrollInput === 'idle' && historyTop() === null) options.scrollToEnd();
        },
        onScroll: ({
          offset,
          contentSize,
          size,
        }: {
          offset: { y: number };
          contentSize: { height: number };
          size: { height: number };
        }) => {
          const movement = offset.y - position.y;
          position.y = offset.y;
          const end = Math.max(0, contentSize.height - size.height);
          const atEnd = end - offset.y <= 1;
          const userMoved = scrollInput !== 'idle' && movement !== 0;
          if (userMoved && scrollInput === 'pending') scrollInput = 'idle';
          // An old automatic scroll report may arrive after more output.
          if (historyTop() === null) {
            if (userMoved && movement < 0 && !atEnd) showHistory(offset.y);
          } else if (atEnd && movement > 0 && (userMoved || options.textTerminal)) {
            historyTop.set(null);
          } else showHistory(offset.y);
        },
      };
    },
  };
}
