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
import { StatTile, type StatTileTone } from '../src/primitives/stat-tile.js';

const meta = {
  title: 'Primitives/StatTile',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const TONES: StatTileTone[] = ['neutral', 'info', 'success', 'warning', 'destructive'];

export const ToneAndEmphasisMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16 }}>
      {(['outline', 'filled'] as const).map((emphasis) => (
        <div key={emphasis} style={{ display: 'grid', gap: 8 }}>
          <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>{emphasis}</span>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(5, minmax(120px, 1fr))' }}>
            {TONES.map((tone, index) => (
              <StatTile
                key={`${emphasis}-${tone}`}
                emphasis={emphasis}
                tone={tone}
                label={tone}
                value={index === 0 ? 0 : index * 12}
                detail={index === 0 ? 'zero neutral' : 'sample'}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};
