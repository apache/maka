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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HOST_RESOURCE_KINDS,
  HOST_RESOURCE_OPERATION_SPECS,
  availableHostResource,
  deriveHostResourceUtilization,
  type HostResourceEnvelope,
  type HostResourceJsonObject,
  type HostResourcesResult,
} from '../protocol/host-resources.js';
import {
  createHostResourceCollector,
  type HostResourceSystemInformation,
} from '../server/host-resource-collector.js';

test('resource snapshots preserve unknown kinds while validating known resources', async () => {
  const provider: HostResourceSystemInformation = {
    async graphics() {
      return {
        controllers: [
          {
            vendor: 'Example',
            model: 'Accelerator',
            bus: 'PCIe',
            vram: 8_192,
            vramDynamic: false,
            utilizationGpu: 25,
          },
        ],
        displays: [],
      };
    },
    async networkStats() {
      throw new Error('network probe unavailable');
    },
    async fsSize() {
      return [
        {
          fs: '/dev/test',
          type: 'ext4',
          size: 10_000,
          used: 4_000,
          available: 6_000,
          use: 40,
          mount: '/',
          rw: true,
        },
      ];
    },
  };
  const collected = await createHostResourceCollector(provider).snapshot('host-epoch');
  const unknown: HostResourceEnvelope = {
    kind: 'example.vendor.npu',
    schemaVersion: 7,
    status: 'available',
    payload: { capacity: { tops: 40 } },
  };
  const decoded = HOST_RESOURCE_OPERATION_SPECS['host.resources.query'].decodeOutput({
    ...collected,
    resources: [...collected.resources, unknown],
  });

  assert.deepEqual(decoded.resources.at(-1), unknown);
  assert.deepEqual(
    decoded.resources.find((resource) => resource.kind === HOST_RESOURCE_KINDS.network),
    {
      kind: HOST_RESOURCE_KINDS.network,
      schemaVersion: 1,
      status: 'unavailable',
      reason: 'probe_failed',
    },
  );
  assert.equal(
    availableHostResource(decoded, HOST_RESOURCE_KINDS.graphics)?.devices[0]?.memory.kind,
    'dedicated',
  );
  assert.deepEqual(availableHostResource(decoded, HOST_RESOURCE_KINDS.storage)?.volumes[0], {
    mount: '/',
    filesystem: 'ext4',
    totalBytes: 10_000,
    availableBytes: 6_000,
  });
  assert.throws(
    () =>
      HOST_RESOURCE_OPERATION_SPECS['host.resources.query'].decodeOutput({
        ...collected,
        resources: collected.resources.map((resource) =>
          resource.kind === HOST_RESOURCE_KINDS.cpu
            ? { ...resource, status: 'available', payload: {} }
            : resource,
        ),
      }),
    /Invalid maka\.system\.cpu resource/u,
  );
  assert.throws(
    () =>
      HOST_RESOURCE_OPERATION_SPECS['host.resources.query'].decodeOutput({
        ...collected,
        resources: [...collected.resources, collected.resources[0]],
      }),
    /Duplicate Runtime Host resource kind/u,
  );
});

test('utilization derives rates from same-epoch cumulative observations', () => {
  const previous = snapshot('host-epoch', 1_000, 100, 200, 1_000, 2_000);
  const current = snapshot('host-epoch', 3_000, 300, 500, 5_000, 8_000);
  assert.deepEqual(deriveHostResourceUtilization(current, previous), {
    memoryPercent: 75,
    cpuPercent: 66.66666666666666,
    receivedBytesPerSecond: 2_000,
    transmittedBytesPerSecond: 3_000,
  });

  const replacement = snapshot('replacement', 5_000, 500, 700, 9_000, 12_000);
  assert.deepEqual(deriveHostResourceUtilization(replacement, current), {
    memoryPercent: 75,
  });
});

function snapshot(
  hostEpoch: string,
  monotonicTimeMilliseconds: number,
  busyTimeMilliseconds: number,
  totalTimeMilliseconds: number,
  receivedBytes: number,
  transmittedBytes: number,
): HostResourcesResult {
  return {
    hostEpoch,
    observedAt: '2026-09-04T00:00:00.000Z',
    monotonicTimeMilliseconds,
    resources: [
      available(HOST_RESOURCE_KINDS.cpu, {
        capacity: {
          model: 'CPU',
          logicalProcessors: 4,
          availableParallelism: 2,
        },
        observation: { busyTimeMilliseconds, totalTimeMilliseconds },
      }),
      available(HOST_RESOURCE_KINDS.memory, {
        capacity: { visibleTotalBytes: 2_000, effectiveTotalBytes: 1_000 },
        observation: { availableBytes: 250 },
      }),
      available(HOST_RESOURCE_KINDS.network, {
        observation: {
          interfaceName: 'eth0',
          monotonicTimeMilliseconds,
          receivedBytes,
          transmittedBytes,
        },
      }),
    ],
  };
}

function available(kind: string, payload: HostResourceJsonObject): HostResourceEnvelope {
  return { kind, schemaVersion: 1, status: 'available', payload };
}
