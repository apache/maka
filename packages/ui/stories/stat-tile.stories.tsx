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
import { StatTile } from '../src/primitives/stat-tile.js';

const meta = {
  title: 'Primitives/StatTile',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** One shape, with and without the optional detail line. */
export const Tiles: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(3, minmax(120px, 1fr))' }}>
      <StatTile label="已允许" value={128} detail="过去 7 天" />
      <StatTile label="已拒绝" value={0} detail="过去 7 天" />
      <StatTile label="待处理" value="1.2k" />
    </div>
  ),
};
