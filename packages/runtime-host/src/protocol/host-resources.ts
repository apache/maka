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

import { z } from 'zod';
import { requireEncodedByteLimit, requireExactRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const HOST_RESOURCE_RESULT_MAX_BYTES = 128 * 1024;
export const HOST_RESOURCE_MAX_ENTRIES = 64;

export const HOST_RESOURCE_KINDS = {
  cpu: 'maka.system.cpu',
  memory: 'maka.system.memory',
  graphics: 'maka.system.graphics',
  network: 'maka.system.network',
  storage: 'maka.system.storage',
} as const;

export type HostResourceJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HostResourceJsonValue[]
  | HostResourceJsonObject;

export interface HostResourceJsonObject {
  readonly [key: string]: HostResourceJsonValue;
}

export type HostResourceUnavailableReason = 'unsupported' | 'permission_denied' | 'probe_failed';

export type HostResourceEnvelope =
  | {
      readonly kind: string;
      readonly schemaVersion: number;
      readonly status: 'available';
      readonly payload: HostResourceJsonObject;
    }
  | {
      readonly kind: string;
      readonly schemaVersion: number;
      readonly status: 'unavailable';
      readonly reason: HostResourceUnavailableReason;
    };

const POSITIVE_COUNT = z.number().int().positive().safe();
const COUNT = z.number().int().nonnegative().safe();
const PERCENTAGE = z.number().min(0).max(100);
const NON_EMPTY_TEXT = z.string().min(1).max(512);

const CPU_RESOURCE_V1_SCHEMA = z
  .strictObject({
    capacity: z.strictObject({
      model: NON_EMPTY_TEXT,
      logicalProcessors: POSITIVE_COUNT,
      availableParallelism: POSITIVE_COUNT,
    }),
    observation: z.strictObject({
      busyTimeMilliseconds: COUNT,
      totalTimeMilliseconds: COUNT,
    }),
  })
  .refine(
    (value) =>
      value.capacity.availableParallelism <= value.capacity.logicalProcessors &&
      value.observation.busyTimeMilliseconds <= value.observation.totalTimeMilliseconds,
    'CPU resource counters exceed capacity',
  );

const MEMORY_RESOURCE_V1_SCHEMA = z
  .strictObject({
    capacity: z.strictObject({
      visibleTotalBytes: POSITIVE_COUNT,
      effectiveTotalBytes: POSITIVE_COUNT,
    }),
    observation: z.strictObject({ availableBytes: COUNT }),
  })
  .refine(
    (value) =>
      value.capacity.effectiveTotalBytes <= value.capacity.visibleTotalBytes &&
      value.observation.availableBytes <= value.capacity.effectiveTotalBytes,
    'memory resource counters exceed capacity',
  );

const GRAPHICS_RESOURCE_V1_SCHEMA = z
  .strictObject({
    detection: z.enum(['detected', 'not_detected', 'unknown']),
    devices: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(128),
          model: NON_EMPTY_TEXT,
          vendor: z.string().min(1).max(256).optional(),
          memory: z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('dedicated'), bytes: POSITIVE_COUNT }),
            z.strictObject({ kind: z.literal('shared') }),
            z.strictObject({ kind: z.literal('unknown') }),
          ]),
          utilizationPercent: PERCENTAGE.optional(),
        }),
      )
      .max(32),
  })
  .refine(
    (value) => (value.detection === 'detected') === value.devices.length > 0,
    'graphics adapter detection does not match its devices',
  );

const NETWORK_RESOURCE_V1_SCHEMA = z.strictObject({
  observation: z.strictObject({
    interfaceName: NON_EMPTY_TEXT,
    monotonicTimeMilliseconds: z.number().nonnegative().finite(),
    receivedBytes: COUNT,
    transmittedBytes: COUNT,
  }),
});

const STORAGE_RESOURCE_V1_SCHEMA = z.strictObject({
  volumes: z
    .array(
      z
        .strictObject({
          mount: z
            .string()
            .min(1)
            .max(2 * 1024),
          filesystem: z.string().min(1).max(128).optional(),
          totalBytes: POSITIVE_COUNT,
          availableBytes: COUNT,
        })
        .refine(
          (volume) => volume.availableBytes <= volume.totalBytes,
          'storage availability exceeds capacity',
        ),
    )
    .max(64),
});

export type HostCpuResourceV1 = z.infer<typeof CPU_RESOURCE_V1_SCHEMA>;
export type HostMemoryResourceV1 = z.infer<typeof MEMORY_RESOURCE_V1_SCHEMA>;
export type HostGraphicsResourceV1 = z.infer<typeof GRAPHICS_RESOURCE_V1_SCHEMA>;
export type HostNetworkResourceV1 = z.infer<typeof NETWORK_RESOURCE_V1_SCHEMA>;
export type HostStorageResourceV1 = z.infer<typeof STORAGE_RESOURCE_V1_SCHEMA>;

export interface HostResourcePayloads {
  readonly [HOST_RESOURCE_KINDS.cpu]: HostCpuResourceV1;
  readonly [HOST_RESOURCE_KINDS.memory]: HostMemoryResourceV1;
  readonly [HOST_RESOURCE_KINDS.graphics]: HostGraphicsResourceV1;
  readonly [HOST_RESOURCE_KINDS.network]: HostNetworkResourceV1;
  readonly [HOST_RESOURCE_KINDS.storage]: HostStorageResourceV1;
}

export type HostResourceKind = keyof HostResourcePayloads;

export interface HostResourcesResult {
  readonly hostEpoch: string;
  readonly observedAt: string;
  readonly monotonicTimeMilliseconds: number;
  readonly resources: readonly HostResourceEnvelope[];
}

export type HostResourcesQueryInput = Record<string, never>;

export const HOST_RESOURCE_OPERATION_SPECS = {
  'host.resources.query': defineOperation({
    mode: 'query',
    availability: 'bootstrap',
    errors: ['host_draining', 'internal_failure'] as const,
    decodeInput: (value) => {
      requireExactRecord(value, 'host.resources.query input', []);
      return {};
    },
    decodeOutput: decodeHostResourcesResult,
  }),
} as const;

export function availableHostResource<K extends HostResourceKind>(
  snapshot: HostResourcesResult | undefined,
  kind: K,
): HostResourcePayloads[K] | undefined {
  const resource = snapshot?.resources.find(
    (candidate) =>
      candidate.kind === kind && candidate.schemaVersion === 1 && candidate.status === 'available',
  );
  return resource?.status === 'available'
    ? (resource.payload as HostResourcePayloads[K])
    : undefined;
}

export interface HostResourceUtilization {
  readonly cpuPercent?: number;
  readonly memoryPercent?: number;
  readonly receivedBytesPerSecond?: number;
  readonly transmittedBytesPerSecond?: number;
}

export function deriveHostResourceUtilization(
  current: HostResourcesResult,
  previous?: HostResourcesResult,
): HostResourceUtilization {
  const memory = availableHostResource(current, HOST_RESOURCE_KINDS.memory);
  const utilization: HostResourceUtilization = {
    ...(memory
      ? {
          memoryPercent: percentage(
            memory.capacity.effectiveTotalBytes - memory.observation.availableBytes,
            memory.capacity.effectiveTotalBytes,
          ),
        }
      : {}),
  };
  if (!previous || previous.hostEpoch !== current.hostEpoch) return utilization;
  const elapsedMilliseconds =
    current.monotonicTimeMilliseconds - previous.monotonicTimeMilliseconds;
  if (elapsedMilliseconds <= 0) return utilization;

  const cpu = availableHostResource(current, HOST_RESOURCE_KINDS.cpu);
  const previousCpu = availableHostResource(previous, HOST_RESOURCE_KINDS.cpu);
  if (cpu && previousCpu) {
    const busyDelta =
      cpu.observation.busyTimeMilliseconds - previousCpu.observation.busyTimeMilliseconds;
    const totalDelta =
      cpu.observation.totalTimeMilliseconds - previousCpu.observation.totalTimeMilliseconds;
    if (busyDelta >= 0 && totalDelta > 0) {
      Object.assign(utilization, { cpuPercent: percentage(busyDelta, totalDelta) });
    }
  }

  const network = availableHostResource(current, HOST_RESOURCE_KINDS.network);
  const previousNetwork = availableHostResource(previous, HOST_RESOURCE_KINDS.network);
  if (
    network &&
    previousNetwork &&
    network.observation.interfaceName === previousNetwork.observation.interfaceName
  ) {
    const networkElapsedMilliseconds =
      network.observation.monotonicTimeMilliseconds -
      previousNetwork.observation.monotonicTimeMilliseconds;
    if (networkElapsedMilliseconds <= 0) return utilization;
    const elapsedSeconds = networkElapsedMilliseconds / 1_000;
    assignRate(
      utilization,
      'receivedBytesPerSecond',
      network.observation.receivedBytes - previousNetwork.observation.receivedBytes,
      elapsedSeconds,
    );
    assignRate(
      utilization,
      'transmittedBytesPerSecond',
      network.observation.transmittedBytes - previousNetwork.observation.transmittedBytes,
      elapsedSeconds,
    );
  }
  return utilization;
}

const ENVELOPE_SCHEMA = z.discriminatedUnion('status', [
  z.strictObject({
    kind: z.string().min(1).max(128),
    schemaVersion: POSITIVE_COUNT,
    status: z.literal('available'),
    payload: z.unknown(),
  }),
  z.strictObject({
    kind: z.string().min(1).max(128),
    schemaVersion: POSITIVE_COUNT,
    status: z.literal('unavailable'),
    reason: z.enum(['unsupported', 'permission_denied', 'probe_failed']),
  }),
]);

const RESULT_SCHEMA = z.strictObject({
  hostEpoch: z.string().min(1).max(128),
  observedAt: z.iso.datetime(),
  monotonicTimeMilliseconds: z.number().nonnegative().finite(),
  resources: z.array(ENVELOPE_SCHEMA).max(HOST_RESOURCE_MAX_ENTRIES),
});

const KNOWN_PAYLOAD_SCHEMAS: Readonly<Record<HostResourceKind, z.ZodType>> = {
  [HOST_RESOURCE_KINDS.cpu]: CPU_RESOURCE_V1_SCHEMA,
  [HOST_RESOURCE_KINDS.memory]: MEMORY_RESOURCE_V1_SCHEMA,
  [HOST_RESOURCE_KINDS.graphics]: GRAPHICS_RESOURCE_V1_SCHEMA,
  [HOST_RESOURCE_KINDS.network]: NETWORK_RESOURCE_V1_SCHEMA,
  [HOST_RESOURCE_KINDS.storage]: STORAGE_RESOURCE_V1_SCHEMA,
};

function decodeHostResourcesResult(value: unknown): HostResourcesResult {
  requireEncodedByteLimit(value, 'host.resources.query result', HOST_RESOURCE_RESULT_MAX_BYTES);
  const result = parse(RESULT_SCHEMA, value, 'Runtime Host resources');
  if (new Set(result.resources.map((resource) => resource.kind)).size !== result.resources.length) {
    throw invalidProtocolFrame('Duplicate Runtime Host resource kind');
  }
  return {
    ...result,
    resources: result.resources.map((resource): HostResourceEnvelope => {
      if (resource.status === 'unavailable') return resource;
      const payload = decodeJsonObject(resource.payload);
      const schema =
        resource.schemaVersion === 1
          ? KNOWN_PAYLOAD_SCHEMAS[resource.kind as HostResourceKind]
          : undefined;
      return {
        ...resource,
        payload: schema
          ? (parse(schema, payload, `${resource.kind} resource`) as HostResourceJsonObject)
          : payload,
      };
    }),
  };
}

function decodeJsonObject(value: unknown): HostResourceJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProtocolFrame('Invalid Runtime Host resource payload');
  }
  return decodeJsonValue(value, 0) as HostResourceJsonObject;
}

function decodeJsonValue(value: unknown, depth: number): HostResourceJsonValue {
  if (depth > 8) throw invalidProtocolFrame('Runtime Host resource payload is too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 256) throw invalidProtocolFrame('Invalid Runtime Host resource payload');
    return value.map((child) => decodeJsonValue(child, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    throw invalidProtocolFrame('Invalid Runtime Host resource payload');
  }
  const entries = Object.entries(value);
  if (entries.length > 128) throw invalidProtocolFrame('Invalid Runtime Host resource payload');
  return Object.fromEntries(
    entries.map(([key, child]) => {
      if (!key || key.length > 128) {
        throw invalidProtocolFrame('Invalid Runtime Host resource payload');
      }
      return [key, decodeJsonValue(child, depth + 1)];
    }),
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidProtocolFrame(`Invalid ${label}`);
  return result.data;
}

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(100, (numerator / denominator) * 100));
}

function assignRate(
  target: HostResourceUtilization,
  key: 'receivedBytesPerSecond' | 'transmittedBytesPerSecond',
  delta: number,
  elapsedSeconds: number,
): void {
  if (delta >= 0) Object.assign(target, { [key]: delta / elapsedSeconds });
}
