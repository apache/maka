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

import { createServicesContext } from '../../application/contracts/feature-services.js';
import type {
  ExternalAgentSetupStart,
  ExternalAgentSetupProjection,
} from '@maka/runtime-host/protocol';
export interface ExternalAgentSettingsHost {
  readonly profileId: string;
  readonly hostId: string;
}
export interface ExternalAgentSettingsServices {
  isAvailable(host: ExternalAgentSettingsHost): Promise<boolean>;
  createAttemptId(): string;
  selectExecutable(host: ExternalAgentSettingsHost): Promise<string | undefined>;
  start(
    input: ExternalAgentSetupStart,
    host: ExternalAgentSettingsHost,
  ): Promise<ExternalAgentSetupProjection>;
  query(attemptId: string, host: ExternalAgentSettingsHost): Promise<ExternalAgentSetupProjection>;
  cancel(attemptId: string, host: ExternalAgentSettingsHost): Promise<ExternalAgentSetupProjection>;
}
const { Provider, useServices } = createServicesContext<ExternalAgentSettingsServices>(
  'ExternalAgentSettingsServicesProvider',
);
export const ExternalAgentSettingsServicesProvider = Provider;
export const useExternalAgentSettingsServices = useServices;
