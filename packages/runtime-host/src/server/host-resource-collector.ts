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

import { existsSync } from 'node:fs';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  HOST_RESOURCE_KINDS,
  type HostCpuResourceV1,
  type HostGraphicsResourceV1,
  type HostMemoryResourceV1,
  type HostNetworkResourceV1,
  type HostResourceEnvelope,
  type HostResourceJsonObject,
  type HostResourcesResult,
  type HostStorageResourceV1,
} from '../protocol/host-resources.js';
import {
  createIsolatedHostResourceSystemInformation,
  type HostResourceSystemInformation,
} from './host-resource-probe.js';

export type { HostResourceSystemInformation } from './host-resource-probe.js';

const SLOW_RESOURCE_CACHE_MILLISECONDS = 10_000;
// Leave process-tree termination and scheduling headroom before the Host's
// 10-second forced-shutdown boundary.
const RESOURCE_PROBE_TIMEOUT_MILLISECONDS = 7_000;

export interface HostResourceCollector {
  snapshot(hostEpoch: string): Promise<HostResourcesResult>;
}

export function createHostResourceCollector(
  provider: HostResourceSystemInformation = createIsolatedHostResourceSystemInformation(
    RESOURCE_PROBE_TIMEOUT_MILLISECONDS,
  ),
): HostResourceCollector {
  const collectGraphics = createResourceProbe({
    collect: () => probeGraphics(provider),
    cacheMilliseconds: SLOW_RESOURCE_CACHE_MILLISECONDS,
  });
  const collectStorage = createResourceProbe({
    collect: () => probeStorage(provider),
    cacheMilliseconds: SLOW_RESOURCE_CACHE_MILLISECONDS,
  });
  const collectNetwork = createResourceProbe({
    collect: () => probeNetwork(provider),
  });

  return {
    async snapshot(hostEpoch): Promise<HostResourcesResult> {
      const [graphics, network, storage] = await Promise.all([
        collectGraphics(),
        collectNetwork(),
        collectStorage(),
      ]);
      const cpu = collectCpu();
      const memory = collectMemory();
      const monotonicTimeMilliseconds = Math.floor(performance.now());
      return {
        hostEpoch,
        observedAt: new Date().toISOString(),
        monotonicTimeMilliseconds,
        resources: [cpu, memory, graphics, network, storage],
      };
    },
  };
}

function createResourceProbe(input: {
  readonly collect: () => Promise<HostResourceEnvelope>;
  readonly cacheMilliseconds?: number;
}): () => Promise<HostResourceEnvelope> {
  let cached: { readonly expiresAt: number; readonly resource: HostResourceEnvelope } | undefined;
  let inFlight: Promise<HostResourceEnvelope> | undefined;
  return async () => {
    const now = performance.now();
    if (cached && cached.expiresAt > now) return cached.resource;
    if (!inFlight) {
      const probe = input.collect().then((resource) => {
        if (input.cacheMilliseconds) {
          cached = {
            expiresAt: performance.now() + input.cacheMilliseconds,
            resource,
          };
        }
        return resource;
      });
      const tracked = probe.finally(() => {
        if (inFlight === tracked) inFlight = undefined;
      });
      inFlight = tracked;
    }
    return inFlight;
  };
}

function collectCpu(): HostResourceEnvelope {
  const processors = cpus();
  const totals = processors.reduce(
    (sum, processor) => {
      const busy =
        processor.times.user + processor.times.nice + processor.times.sys + processor.times.irq;
      return {
        busy: sum.busy + busy,
        total: sum.total + busy + processor.times.idle,
      };
    },
    { busy: 0, total: 0 },
  );
  const payload: HostCpuResourceV1 = {
    capacity: {
      model: processors[0]?.model.trim() || 'Unknown CPU',
      logicalProcessors: Math.max(1, processors.length),
      availableParallelism: Math.max(1, availableParallelism()),
    },
    observation: {
      busyTimeMilliseconds: Math.max(0, Math.floor(totals.busy)),
      totalTimeMilliseconds: Math.max(0, Math.floor(totals.total)),
    },
  };
  return availableResource(HOST_RESOURCE_KINDS.cpu, payload);
}

function collectMemory(): HostResourceEnvelope {
  const visibleTotalBytes = totalmem();
  const constrainedBytes = process.constrainedMemory();
  const effectiveTotalBytes =
    constrainedBytes > 0 ? Math.min(visibleTotalBytes, constrainedBytes) : visibleTotalBytes;
  const availableBytes = Math.min(effectiveTotalBytes, process.availableMemory());
  const payload: HostMemoryResourceV1 = {
    capacity: {
      visibleTotalBytes,
      effectiveTotalBytes,
    },
    observation: {
      availableBytes: Math.max(0, availableBytes),
    },
  };
  return availableResource(HOST_RESOURCE_KINDS.memory, payload);
}

async function probeGraphics(
  provider: HostResourceSystemInformation,
): Promise<HostResourceEnvelope> {
  try {
    const graphics = await provider.graphics();
    const devices = graphics.controllers.slice(0, 32).map((controller, index) => {
      const memoryMegabytes = finitePositive(controller.memoryTotal)
        ? controller.memoryTotal
        : finitePositive(controller.vram)
          ? controller.vram
          : undefined;
      return {
        id: `gpu-${index}`,
        model:
          controller.model.trim() || controller.name?.trim() || `Graphics adapter ${index + 1}`,
        ...(controller.vendor.trim() ? { vendor: controller.vendor.trim() } : {}),
        memory: controller.vramDynamic
          ? ({ kind: 'shared' } as const)
          : memoryMegabytes === undefined
            ? ({ kind: 'unknown' } as const)
            : ({
                kind: 'dedicated',
                bytes: Math.floor(memoryMegabytes * 1024 * 1024),
              } as const),
        ...(finitePercentage(controller.utilizationGpu)
          ? { utilizationPercent: controller.utilizationGpu }
          : {}),
      };
    });
    const payload: HostGraphicsResourceV1 = {
      detection:
        devices.length > 0
          ? 'detected'
          : process.platform === 'linux' && existsSync('/dev/dxg')
            ? 'unknown'
            : 'not_detected',
      devices,
    };
    return availableResource(HOST_RESOURCE_KINDS.graphics, payload);
  } catch {
    const payload: HostGraphicsResourceV1 = { detection: 'unknown', devices: [] };
    return availableResource(HOST_RESOURCE_KINDS.graphics, payload);
  }
}

async function probeNetwork(
  provider: HostResourceSystemInformation,
): Promise<HostResourceEnvelope> {
  try {
    const { interfaceName, stats } = await provider.networkStats();
    if (!interfaceName) {
      return unavailableResource(HOST_RESOURCE_KINDS.network, 'unsupported');
    }
    const observed = stats[0];
    if (
      stats.length !== 1 ||
      !observed ||
      observed.iface.toLowerCase() !== interfaceName.toLowerCase() ||
      observed.operstate !== 'up'
    ) {
      return unavailableResource(HOST_RESOURCE_KINDS.network, 'probe_failed');
    }
    const payload: HostNetworkResourceV1 = {
      observation: {
        interfaceName,
        monotonicTimeMilliseconds: Math.floor(performance.now()),
        receivedBytes: safeCounter(observed.rx_bytes),
        transmittedBytes: safeCounter(observed.tx_bytes),
      },
    };
    return availableResource(HOST_RESOURCE_KINDS.network, payload);
  } catch {
    return unavailableResource(HOST_RESOURCE_KINDS.network, 'probe_failed');
  }
}

async function probeStorage(
  provider: HostResourceSystemInformation,
): Promise<HostResourceEnvelope> {
  try {
    const volumes = (await provider.fsSize())
      .filter((volume) => finitePositive(volume.size) && volume.mount.trim())
      .slice(0, 64)
      .map((volume) => ({
        mount: volume.mount.trim(),
        ...(volume.type.trim() ? { filesystem: volume.type.trim() } : {}),
        totalBytes: Math.floor(volume.size),
        availableBytes: Math.max(0, Math.min(Math.floor(volume.available), volume.size)),
      }));
    const payload: HostStorageResourceV1 = { volumes };
    return availableResource(HOST_RESOURCE_KINDS.storage, payload);
  } catch {
    return unavailableResource(HOST_RESOURCE_KINDS.storage, 'probe_failed');
  }
}

function availableResource(kind: string, payload: HostResourceJsonObject): HostResourceEnvelope {
  return { kind, schemaVersion: 1, status: 'available', payload };
}

function unavailableResource(
  kind: string,
  reason: 'unsupported' | 'permission_denied' | 'probe_failed',
): HostResourceEnvelope {
  return { kind, schemaVersion: 1, status: 'unavailable', reason };
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finitePercentage(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function safeCounter(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
