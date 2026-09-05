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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { AgentGraphServices } from '../../features/agent-graph';

export type DesktopAgentGraphBridge = Pick<MakaBridge, 'graphs'>;

export function createDesktopAgentGraphServices(
  bridge: DesktopAgentGraphBridge = window.maka,
): AgentGraphServices {
  return {
    graphs: {
      listEpochs: (rootSessionId) => bridge.graphs.listEpochs(rootSessionId),
      listCurrentEpochs: (rootSessionId) => bridge.graphs.listCurrentEpochs(rootSessionId),
      getSnapshot: (rootSessionId, options) => bridge.graphs.getSnapshot(rootSessionId, options),
      inspectOperator: (rootSessionId, operatorId, graphId) =>
        bridge.graphs.inspectOperator(rootSessionId, operatorId, graphId),
      stop: (rootSessionId, expectedGraphId) =>
        bridge.graphs.stop(rootSessionId, expectedGraphId),
      subscribe: (rootSessionId, handler) => bridge.graphs.subscribe(rootSessionId, handler),
    },
  };
}
