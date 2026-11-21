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
import { useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Overlay } from '@astryxdesign/core/Overlay';
import { Switch } from '@astryxdesign/core/Switch';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Table, proportional, useTableSortable, useTableSortableState } from '@astryxdesign/core/Table';

const meta = {
  title: 'Design System/Astryx Hover Compatibility',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const rows = [{ name: 'Beta', value: 2 }, { name: 'Alpha', value: 1 }];

// Review scaffold for #5842: actual package components and their owning input
// contracts. These panels are component states, not a second product screen.
function HoverCompatibility() {
  const [enabled, setEnabled] = useState(false);
  const [checked, setChecked] = useState(false);
  const [activeTab, setActiveTab] = useState('first');
  const [overlayActions, setOverlayActions] = useState(0);
  const { sortedData, sortConfig } = useTableSortableState({ data: rows });
  const sort = useTableSortable(sortConfig);
  return (
    <div style={{ maxWidth: 720, display: 'grid', gap: 20 }}>
      <section>
        <h2>Overlay</h2>
        <Overlay showOn="hover-or-focus" content={
          <Button label="Overlay action" onClick={() => setOverlayActions((n) => n + 1)} />
        }>
          <div style={{ height: 100, padding: 16, background: '#dbeafe' }}>
            <Button label="Overlay base" />
          </div>
        </Overlay>
        <p>Overlay actions: {overlayActions}</p>
      </section>
      <section>
        <h2>Indicator owning controls</h2>
        <CheckboxInput label="Enabled checkbox" value={checked} onChange={setChecked} />
        <CheckboxInput label="Disabled checkbox" value={false} isDisabled />
      </section>
      <section>
        <h2>Switch</h2>
        <Switch label="Enabled switch" value={enabled} onChange={setEnabled} />
        <Switch label="Disabled switch" value={false} isDisabled />
      </section>
      <section>
        <h2>TabList</h2>
        <TabList value={activeTab} onChange={setActiveTab} role="tablist" aria-label="Compatibility tabs">
          <Tab value="first" label="First tab" panelId="compatibility-panel" />
          <Tab value="second" label="Second tab" panelId="compatibility-panel" />
        </TabList>
        <div id="compatibility-panel" role="tabpanel">Selected: {activeTab}</div>
      </section>
      <section>
        <h2>Table</h2>
        <Table data={sortedData} hasHover plugins={{ sort }} columns={[
          { key: 'name', header: 'Name', width: proportional(1), sortable: true },
          { key: 'value', header: 'Value', width: proportional(1) },
        ]} />
      </section>
    </div>
  );
}

export const PointerAndKeyboard: Story = { render: () => <HoverCompatibility /> };
