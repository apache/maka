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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Spinner } from '@astryxdesign/core/Spinner';

// The two functional animations the product keeps: a spinner and the streaming
// shimmer. Both are load-bearing rather than decorative, so they outlive the
// motion-token rename — unlike the duration/easing scales that used to sit here
// and catalogued Maka's parallel motion vocabulary as if it were the contract.
const meta = {
  title: 'Design System/Functional Motion',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const RetainedFunctionalMotion: Story = {
  render: () => (
    <div style={{ alignItems: 'end', display: 'grid', gap: 24, gridTemplateColumns: 'repeat(2, minmax(96px, 1fr))' }}>
      {/* This story is the keyframe's only consumer since the product's
          `.maka-shimmer` recipe died (#1980), so the keyframe lives here
          rather than in maka-tokens.css. */}
      <style>{'@keyframes maka-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }'}</style>
      <div style={{ alignItems: 'center', display: 'grid', gap: 8, justifyItems: 'center' }}>
        <Spinner style={{ height: 20, width: 20 }} />
        <span style={{ color: 'var(--foreground-secondary)', fontSize: 12, fontWeight: 600 }}>Spinner</span>
      </div>
      <div style={{ alignItems: 'center', display: 'grid', gap: 8, justifyItems: 'center' }}>
        <span
          aria-hidden="true"
          style={{
            animation: 'maka-shimmer 1.8s var(--ease-linear) infinite',
            background:
              'linear-gradient(120deg, transparent 40%, oklch(from var(--foreground) l c h / 0.16), transparent 60%) var(--foreground-5) 0 0 / 200% 100%',
            borderRadius: 'var(--radius-surface)',
            display: 'inline-block',
            height: 20,
            width: 96,
          }}
        />
        <span style={{ color: 'var(--foreground-secondary)', fontSize: 12, fontWeight: 600 }}>Shimmer</span>
      </div>
    </div>
  ),
};
