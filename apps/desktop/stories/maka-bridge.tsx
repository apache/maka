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

import { useLayoutEffect } from 'react';
import type { Decorator } from '@storybook/react-vite';

type MakaGlobal = Record<string, unknown>;
type MakaWindow = { maka?: MakaGlobal };

export function withScopedMakaBridge(bridge: MakaGlobal): Decorator {
  return (Story) => {
    const target = window as unknown as MakaWindow;
    useLayoutEffect(() => {
      const hadPrevious = 'maka' in target;
      const previous = target.maka;
      target.maka = bridge;
      return () => {
        if (target.maka === bridge) {
          if (hadPrevious) {
            target.maka = previous;
          } else {
            delete target.maka;
          }
        }
      };
    }, []);
    return <Story />;
  };
}