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

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import {
  useWorkbarController,
  type UseWorkbarControllerInput,
} from '../controller/use-workbar-controller.js';
import {
  createWorkbarShellBridge,
  type WorkbarShellBridge,
} from '../controller/workbar-shell-bridge.js';
import type { WorkbarHostModel } from './workbar-host.js';

export interface WorkbarTitlebarModel {
  readonly available: boolean;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

const WorkbarHostContext = createContext<WorkbarHostModel | null>(null);
const WorkbarTitlebarContext = createContext<WorkbarTitlebarModel | null>(null);

export interface WorkbarProviderProps extends UseWorkbarControllerInput {
  readonly bridge: WorkbarShellBridge;
  readonly children?: ReactNode;
}

/** Owns one imperative bridge for the lifetime of its shell. */
export function WorkbarShellBridgeOwner(props: {
  readonly children: (bridge: WorkbarShellBridge) => ReactNode;
}) {
  const bridgeRef = useRef<WorkbarShellBridge | null>(null);
  bridgeRef.current ??= createWorkbarShellBridge();
  return props.children(bridgeRef.current);
}

/**
 * Owns the Workbar controller below AppShell and publishes only the models
 * read by the host, titlebar, and Session rail.
 *
 * Controller updates re-render this provider and the matching context reader.
 * The shell's cross-feature intents use stable imperative delegates on
 * `bridge`; only hidden companion Session ids create a reactive subscription.
 */
export function WorkbarProvider({
  bridge,
  reportError: reportErrorInput,
  children,
  ...input
}: WorkbarProviderProps) {
  const reportErrorRef = useRef(reportErrorInput);
  useLayoutEffect(() => {
    reportErrorRef.current = reportErrorInput;
  }, [reportErrorInput]);
  const reportError = useCallback<UseWorkbarControllerInput['reportError']>(
    (...args) => reportErrorRef.current(...args),
    [],
  );
  const controller = useWorkbarController({ ...input, reportError });

  useLayoutEffect(() => {
    bridge.publish({
      commands: controller.commands,
      selectors: controller.selectors,
    });
  });
  useLayoutEffect(() => () => bridge.disconnect(), [bridge]);

  const titlebar = useMemo<WorkbarTitlebarModel>(
    () => ({
      available: input.available,
      collapsed: controller.selectors.rightCollapsed,
      onToggle: controller.commands.toggleRight,
    }),
    [
      controller.commands.toggleRight,
      controller.selectors.rightCollapsed,
      input.available,
    ],
  );

  return (
    <WorkbarTitlebarContext.Provider value={titlebar}>
      <WorkbarHostContext.Provider value={controller.host}>
        {children}
      </WorkbarHostContext.Provider>
    </WorkbarTitlebarContext.Provider>
  );
}

export function useWorkbarHostModel(): WorkbarHostModel {
  const model = useContext(WorkbarHostContext);
  if (!model) throw new Error('WorkbarProvider is missing');
  return model;
}

export function useWorkbarTitlebarModel(): WorkbarTitlebarModel {
  const model = useContext(WorkbarTitlebarContext);
  if (!model) throw new Error('WorkbarProvider is missing');
  return model;
}
