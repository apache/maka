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

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

export interface ServicesContext<S> {
  /** Mounts one services object for the feature's subtree. */
  readonly Provider: (props: {
    readonly services: S;
    readonly children?: ReactNode;
  }) => ReactElement;
  /** Reads the mounted services; throws when the Provider is missing. */
  readonly useServices: () => S;
}

/**
 * One services context per feature slice.
 *
 * A slice declares its inward-facing services type in `ports.ts` and gets the
 * Provider/hook pair from here instead of restating twenty lines of
 * `createContext` boilerplate. `providerName` is the Provider's displayName
 * and the name in the error a consumer sees when nothing is mounted, so the
 * message stays `<Feature>ServicesProvider is missing` for every slice.
 */
export function createServicesContext<S>(providerName: string): ServicesContext<S> {
  const Context = createContext<S | null>(null);
  function Provider(props: {
    readonly services: S;
    readonly children?: ReactNode;
  }): ReactElement {
    return <Context.Provider value={props.services}>{props.children}</Context.Provider>;
  }
  Provider.displayName = providerName;
  function useServices(): S {
    const services = useContext(Context);
    if (!services) throw new Error(`${providerName} is missing`);
    return services;
  }
  return { Provider, useServices };
}
