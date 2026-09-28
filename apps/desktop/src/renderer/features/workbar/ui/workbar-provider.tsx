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
  useContext,
  useLayoutEffect,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  useWorkbarController,
  type UseWorkbarControllerInput,
} from '../controller/use-workbar-controller.js';
import type { WorkbarShellBridge } from '../controller/workbar-shell-bridge.js';
import type { WorkbarHostModel } from './workbar-host.js';

const WorkbarHostModelContext = createContext<WorkbarHostModel | null>(null);

/**
 * Sole Workbar controller owner. Its updates reuse children built by the
 * shell, so only the host model's readers (the host and its titlebar restore
 * affordance) re-render; the shell reads the bridge's narrow state instead.
 */
export function WorkbarProvider(props: {
  readonly bridge: WorkbarShellBridge;
  readonly input: UseWorkbarControllerInput;
  readonly children?: ReactNode;
}) {
  const controller = useWorkbarController(props.input);
  useLayoutEffect(() => props.bridge.publish(controller), [props.bridge, controller]);
  useLayoutEffect(() => () => props.bridge.disconnect(), [props.bridge]);
  // Shell columns and the titlebar reserve both size from the Workbar width.
  // An inherited custom property carries it to them without re-rendering the
  // shell on every resize step.
  const style = {
    '--maka-session-workbar-width': `${controller.host.rightWidth}px`,
  } as CSSProperties;
  return (
    <WorkbarHostModelContext.Provider value={controller.host}>
      <div className="maka-workbar-shell-vars" style={style}>
        {props.children}
      </div>
    </WorkbarHostModelContext.Provider>
  );
}

export function useWorkbarHostModel(): WorkbarHostModel {
  const model = useContext(WorkbarHostModelContext);
  if (!model) throw new Error('WorkbarProvider is missing');
  return model;
}
