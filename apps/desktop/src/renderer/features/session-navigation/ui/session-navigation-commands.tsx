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
import type { SessionNavigationPorts } from '../ports.js';
import type { SessionNavigationRowActions } from '../controller/session-row-actions.js';
import { useSessionNavigationRowActions } from '../controller/use-session-navigation-row-actions.js';
import { useSessionNavigationServices } from '../services-context.js';

/** A session window retains header actions without mounting rail navigation. */
export function SessionNavigationCommands(props: {
  ports: SessionNavigationPorts;
  commandsRef: { current: SessionNavigationRowActions | null };
}) {
  const { sessions } = useSessionNavigationServices();
  const commands = useSessionNavigationRowActions(props.ports, sessions);
  useLayoutEffect(() => {
    props.commandsRef.current = commands;
    return () => { props.commandsRef.current = null; };
  }, [commands, props.commandsRef]);
  return null;
}
