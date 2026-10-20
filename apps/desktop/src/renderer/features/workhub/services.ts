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

import { createElement, type ReactNode } from 'react';
import { WorkHubWorkspaceServicesProvider } from '../../application/contracts/workhub-workspace/use-workhub-workspace.js';
import { createServicesContext } from '../../application/contracts/feature-services.js';
import type { WorkHubServices } from './ports.js';
const context = createServicesContext<WorkHubServices>('WorkHubServicesProvider');
export function WorkHubServicesProvider(props: { services: WorkHubServices; children?: ReactNode }) {
  return createElement(WorkHubWorkspaceServicesProvider, { value: props.services },
    createElement(context.Provider, props));
}
export const useWorkHubServices = context.useServices;
