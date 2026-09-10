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

/**
 * React's development component tracks retain a PerformanceMeasure (including
 * serialized prop diagnostics) for each render. The browser performance entry
 * buffer owns them even after GC. Retire only React's records after delivery;
 * the DevTools trace and other PerformanceObservers still receive the measures.
 */
function isReactPerformanceMeasure(entry: PerformanceEntry): boolean {
  const detail = (entry as PerformanceMeasure).detail;
  return (
    detail?.devtools?.track === 'Components ⚛' ||
    detail?.devtools?.trackGroup === 'Scheduler ⚛'
  );
}

export function observeReactPerformanceMeasures(): () => void {
  const observer = new PerformanceObserver((list) => {
    const names = new Set<string>();
    for (const entry of list.getEntries()) {
      if (isReactPerformanceMeasure(entry)) names.add(entry.name);
    }
    for (const name of names) {
      const entries = performance.getEntriesByName(name, 'measure');
      if (entries.length > 0 && entries.every(isReactPerformanceMeasure)) {
        performance.clearMeasures(name);
      }
    }
  });
  observer.observe({ type: 'measure', buffered: true });
  return () => observer.disconnect();
}
