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

import { useEffect, useState, type ReactNode } from 'react';
import { usePersonalAssistantServices } from './services.js';
import { originalHost } from './navigation.js';

/** Only the visible assistant polls its lightweight binding, never memory or task refresh. */
export function PersonalAssistantTyping({ sessionId, avatar }: { sessionId: string; avatar: ReactNode }) {
  const services = usePersonalAssistantServices();
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const target = originalHost(sessionId, (await services.hostSnapshot()).entries);
        const result = await services.call('assistant.binding', {}, target.host);
        if (live) setWorking(result.state?.sessionId === target.sessionId && result.bot?.working === true);
      } catch {
        if (live) setWorking(false);
      } finally {
        if (live) timer = setTimeout(refresh, 1000);
      }
    };
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [sessionId, services]);
  if (!working) return null;
  return (
    <div className="personal-assistant-typing" role="status" aria-label="正在输入">
      {avatar}
      <div className="personal-assistant-typing-bubble" aria-hidden="true">
        <span /><span /><span />
      </div>
    </div>
  );
}
