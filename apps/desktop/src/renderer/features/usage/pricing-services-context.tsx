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

import { createContext, useContext, type ReactNode } from 'react';
import type { UsagePricingServices } from './pricing-ports.js';

// The pricing services are Host-agnostic at this seam: the platform adapter
// targets the settings-selected Runtime Host inside the preload bridge, so a
// single app-root provider serves every mount. A Host/generation change is
// surfaced to the pricing controller via the Usage scope's `targetKey` (threaded
// as `generationKey`), which drives the reload — not by remounting a keyed
// provider.
const UsagePricingServicesContext = createContext<UsagePricingServices | null>(null);

export function UsagePricingServicesProvider(props: {
  readonly services: UsagePricingServices;
  readonly children?: ReactNode;
}) {
  return (
    <UsagePricingServicesContext.Provider value={props.services}>
      {props.children}
    </UsagePricingServicesContext.Provider>
  );
}

export function useUsagePricingServices(): UsagePricingServices {
  const services = useContext(UsagePricingServicesContext);
  if (!services) throw new Error('UsagePricingServicesProvider is missing');
  return services;
}
