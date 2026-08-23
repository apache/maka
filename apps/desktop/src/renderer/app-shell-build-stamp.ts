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

import { useEffect, useState } from 'react';
import type { SidebarBuildStamp } from '@maka/ui';

/**
 * The running build, for the rail's footer.
 *
 * Read once at mount and never again: neither the version nor the commit can
 * change without the process restarting, so a subscription would re-render for
 * a value that cannot move.
 *
 * Failure is silent and the stamp is simply absent. This is an orientation
 * label — a rail that shows nothing is strictly better than one that shows an
 * error where a version belongs, and the About page reports the same failure
 * where a user went looking for it.
 */
export function useBuildStamp(): SidebarBuildStamp | undefined {
  const [stamp, setStamp] = useState<SidebarBuildStamp | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    window.maka.app
      .info()
      .then((info) => {
        if (cancelled) return;
        setStamp({ version: info.appVersion, commit: info.buildCommit });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return stamp;
}
