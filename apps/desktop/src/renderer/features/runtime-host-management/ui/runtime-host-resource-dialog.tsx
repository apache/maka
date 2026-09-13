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

import { useEffect, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import {
  HOST_RESOURCE_KINDS,
  availableHostResource,
  deriveHostResourceUtilization,
  type HostResourcesResult,
} from '@maka/runtime-host/protocol';
import type { UiLocale } from '@maka/core/ui-locale';
import { Button, Spinner, Text, formatBytes, useUiLocale } from '@maka/ui';
import { useRuntimeHostManagementServices } from '../services-context.js';

const POLL_INTERVAL_MILLISECONDS = 2_000;

type HostResourceState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly current: HostResourcesResult;
      readonly previous?: HostResourcesResult;
    };

export function RuntimeHostResourceDialog(props: {
  readonly profileId: string;
  readonly hostName: string;
}) {
  const [open, setOpen] = useState(false);
  const copy = hostResourceCopy(useUiLocale());
  return (
    <>
      <div className="settingsRuntimeHostUpdatePolicyActions">
        <Button
          variant="secondary"
          size="sm"
          label={copy.open}
          onClick={() => setOpen(true)}
        />
      </div>
      {open ? (
        <Dialog
          isOpen
          onOpenChange={setOpen}
          purpose="form"
          width={640}
          maxHeight="calc(100dvh - 64px)"
        >
          <Layout
            header={(
              <DialogHeader
                title={copy.title}
                subtitle={props.hostName}
                onOpenChange={setOpen}
              />
            )}
            content={(
              <LayoutContent padding={4}>
                <RuntimeHostResourceFacts profileId={props.profileId} copy={copy} />
              </LayoutContent>
            )}
            footer={(
              <LayoutFooter hasDivider>
                <div className="settingsRuntimeHostManagementActions">
                  <Button variant="secondary" label={copy.done} onClick={() => setOpen(false)} />
                </div>
              </LayoutFooter>
            )}
          />
        </Dialog>
      ) : null}
    </>
  );
}

function RuntimeHostResourceFacts(props: {
  readonly profileId: string;
  readonly copy: ReturnType<typeof hostResourceCopy>;
}) {
  const services = useRuntimeHostManagementServices().resources;
  const [state, setState] = useState<HostResourceState>({ kind: 'loading' });

  useEffect(() => {
    let disposed = false;
    let cancelSchedule: (() => void) | undefined;
    const poll = async () => {
      try {
        const snapshot = await services.query(props.profileId);
        if (disposed) return;
        setState((current) =>
          snapshot
            ? {
                kind: 'ready',
                current: snapshot,
                ...(current.kind === 'ready' ? { previous: current.current } : {}),
              }
            : { kind: 'unavailable' },
        );
      } catch {
        if (!disposed) setState({ kind: 'unavailable' });
      } finally {
        if (!disposed) cancelSchedule = services.schedule(poll, POLL_INTERVAL_MILLISECONDS);
      }
    };
    void poll();
    return () => {
      disposed = true;
      cancelSchedule?.();
    };
  }, [props.profileId, services]);

  if (state.kind !== 'ready') {
    return (
      <section className="settingsRuntimeHostResources">
        {state.kind === 'loading' ? (
          <div className="settingsRuntimeHostSetupProgress" role="status">
            <Spinner size="sm" />
            <Text type="supporting">{props.copy.measuring}</Text>
          </div>
        ) : (
          <Text type="supporting" color="secondary">{props.copy.unavailable}</Text>
        )}
      </section>
    );
  }

  const cpu = availableHostResource(state.current, HOST_RESOURCE_KINDS.cpu);
  const memory = availableHostResource(state.current, HOST_RESOURCE_KINDS.memory);
  const graphics = availableHostResource(state.current, HOST_RESOURCE_KINDS.graphics);
  const network = availableHostResource(state.current, HOST_RESOURCE_KINDS.network);
  const storage = availableHostResource(state.current, HOST_RESOURCE_KINDS.storage);
  const utilization = deriveHostResourceUtilization(state.current, state.previous);
  const effectiveMemory = memory?.capacity.effectiveTotalBytes;
  const usedMemory = memory
    ? Math.max(0, memory.capacity.effectiveTotalBytes - memory.observation.availableBytes)
    : undefined;
  const graphicsSummary = !graphics || graphics.detection === 'unknown'
    ? props.copy.graphicsUnknown
    : graphics.detection === 'not_detected'
      ? props.copy.noGraphicsAdapter
      : graphics.devices
          .map((device) => {
            const name = [device.vendor, device.model].filter(Boolean).join(' ');
            const graphicsMemory = device.memory.kind === 'dedicated'
              ? formatBytes(device.memory.bytes)
              : device.memory.kind === 'shared'
                ? props.copy.sharedMemory
                : props.copy.memoryUnknown;
            const load = device.utilizationPercent === undefined
              ? undefined
              : formatPercent(device.utilizationPercent);
            return [name, graphicsMemory, load].filter(Boolean).join(' · ');
          })
          .join('\n');
  const storageSummary = storage?.volumes.length
    ? [...storage.volumes]
        .sort(
          (left, right) => storageMountPriority(left.mount) - storageMountPriority(right.mount),
        )
        .slice(0, 8)
        .map((volume) =>
          props.copy.storageVolume(
            volume.mount,
            formatBytes(volume.availableBytes),
            formatBytes(volume.totalBytes),
            volume.filesystem,
          ),
        )
        .join('\n')
    : props.copy.unavailable;

  return (
    <section className="settingsRuntimeHostResources">
      <dl className="settingsRuntimeHostManagementFacts">
        <ResourceFact
          label={props.copy.cpu}
          value={cpu
            ? `${cpu.capacity.model} · ${props.copy.logicalProcessors(
                cpu.capacity.logicalProcessors,
                cpu.capacity.availableParallelism,
              )}`
            : props.copy.unavailable}
          wide
        />
        <ResourceFact
          label={props.copy.cpuUsage}
          value={!cpu
            ? props.copy.unavailable
            : utilization.cpuPercent === undefined
              ? props.copy.measuring
              : formatPercent(utilization.cpuPercent)}
        />
        <ResourceFact
          label={props.copy.memory}
          value={usedMemory === undefined || effectiveMemory === undefined
            ? props.copy.unavailable
            : `${formatBytes(usedMemory)} / ${formatBytes(effectiveMemory)} · ${formatPercent(
                utilization.memoryPercent ?? 0,
              )}`}
        />
        <ResourceFact label={props.copy.graphics} value={graphicsSummary} wide />
        <ResourceFact label={props.copy.storage} value={storageSummary} wide />
        <ResourceFact
          label={props.copy.network}
          value={
            !network
              ? props.copy.unavailable
              : utilization.receivedBytesPerSecond === undefined ||
            utilization.transmittedBytesPerSecond === undefined
                ? props.copy.measuring
                : props.copy.networkRate(
                    network.observation.interfaceName,
                    formatBytes(utilization.receivedBytesPerSecond),
                    formatBytes(utilization.transmittedBytesPerSecond),
                  )
          }
        />
      </dl>
    </section>
  );
}

function ResourceFact(props: {
  readonly label: string;
  readonly value: string;
  readonly wide?: boolean;
}) {
  return (
    <div className={props.wide ? 'settingsRuntimeHostManagementFactWide' : undefined}>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function storageMountPriority(mount: string): number {
  if (mount === '/' || /^[A-Za-z]:\\?$/u.test(mount)) return 0;
  if (/^\/mnt\/[A-Za-z](?:\/|$)/u.test(mount)) return 1;
  return 2;
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

const HOST_RESOURCE_COPY = {
  'zh-CN': {
    title: '主机资源',
    open: '查看主机资源',
    done: '完成',
    unavailable: 'Host 连接后即可读取资源信息',
    cpu: 'CPU',
    cpuUsage: 'CPU 使用率',
    memory: '内存',
    graphics: '显示适配器',
    storage: '磁盘',
    noGraphicsAdapter: '未检测到',
    graphicsUnknown: '无法确认',
    sharedMemory: '共享内存',
    memoryUnknown: '显存未知',
    network: '网络吞吐',
    measuring: '正在采样…',
    logicalProcessors: (count: number, available: number) =>
      count === available
        ? `${count} 个逻辑处理器`
        : `${available} / ${count} 个逻辑处理器可用`,
    networkRate: (interfaceName: string, received: string, transmitted: string) =>
      `${interfaceName} · ↓ ${received}/s · ↑ ${transmitted}/s`,
    storageVolume: (
      mount: string,
      available: string,
      total: string,
      filesystem: string | undefined,
    ) => `${mount} · ${available} 可用 / ${total}${filesystem ? ` · ${filesystem}` : ''}`,
  },
  'zh-TW': {
    title: '主機資源',
    open: '檢視主機資源',
    done: '完成',
    unavailable: 'Host 連線後即可讀取資源資訊',
    cpu: 'CPU',
    cpuUsage: 'CPU 使用率',
    memory: '記憶體',
    graphics: '顯示卡',
    storage: '儲存空間',
    noGraphicsAdapter: '未偵測到',
    graphicsUnknown: '無法判定',
    sharedMemory: '共享記憶體',
    memoryUnknown: '顯示記憶體未知',
    network: '網路輸送量',
    measuring: '正在測量…',
    logicalProcessors: (count: number, available: number) =>
      count === available
        ? `${count} 個邏輯處理器`
        : `${available} / ${count} 個邏輯處理器可用`,
    networkRate: (interfaceName: string, received: string, transmitted: string) =>
      `${interfaceName} · ↓ ${received}/s · ↑ ${transmitted}/s`,
    storageVolume: (
      mount: string,
      available: string,
      total: string,
      filesystem: string | undefined,
    ) => `${mount} · ${available} 可用 / ${total}${filesystem ? ` · ${filesystem}` : ''}`,
  },
  en: {
    title: 'Host resources',
    open: 'View Host resources',
    done: 'Done',
    unavailable: 'Resource information is available while the Host is connected',
    cpu: 'CPU',
    cpuUsage: 'CPU usage',
    memory: 'Memory',
    graphics: 'Graphics adapters',
    storage: 'Storage',
    noGraphicsAdapter: 'None detected',
    graphicsUnknown: 'Unable to determine',
    sharedMemory: 'Shared memory',
    memoryUnknown: 'Memory unknown',
    network: 'Network throughput',
    measuring: 'Measuring…',
    logicalProcessors: (count: number, available: number) =>
      count === available
        ? `${count} logical processors`
        : `${available} of ${count} logical processors available`,
    networkRate: (interfaceName: string, received: string, transmitted: string) =>
      `${interfaceName} · ↓ ${received}/s · ↑ ${transmitted}/s`,
    storageVolume: (
      mount: string,
      available: string,
      total: string,
      filesystem: string | undefined,
    ) =>
      `${mount} · ${available} available / ${total}${filesystem ? ` · ${filesystem}` : ''}`,
  },
} satisfies Record<UiLocale, unknown>;

function hostResourceCopy(locale: UiLocale) {
  return HOST_RESOURCE_COPY[locale];
}
