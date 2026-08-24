<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Computer Use Evidence Classes

Computer Use reports use one of four evidence classes. The class is part of
the qualification boundary and is not descriptive copy.

## real-runtime

A live provider used the production Runtime, Computer Use tool, owned fixture,
and executor path. Provider qualification additionally requires:

- `complete/end_turn`;
- enforced or explicitly reported policy provenance;
- exact provider, model, producer, and live transport identity;
- successful or scenario-expected actions within pre-dispatch budgets;
- fixture process-instance PID/window ownership for every targeted action,
  including both old and replacement instances in restart scenarios;
- observation lineage for every observation-bound action;
- the scenario's exact action sequence when one is declared;
- AX or semantic dispatch evidence for mutations;
- passing expected-state and forbidden-effect assertions.

Missing evidence is invalid or inconclusive. It is never inferred from fixture
state alone.

## fault-injection

The live provider and production Runtime ran, but the named failure was
injected by a wrapper rather than observed from the real host boundary.
`intervention-recovery` currently belongs here because the wrapper injects
`user_intervened` before the backend and HID-age guard run.

Fault-injection reports are useful regression evidence but cannot satisfy a
`real-runtime` provider qualification cell.

## hermetic-protocol

A local protocol server verified provider URL, authentication, model ID,
streaming tool calls, tool-result reinjection, error flags, and final semantic
state. No live provider credential or network model execution is claimed.

## static-contract

Source, schema, or deterministic harness checks only. The superseded direct
real-machine qualification runner was removed. The five-round process-restart
runner remains as a non-qualifying soak after its qualification checks moved
into the canonical Runtime-backed harness.

The canonical operator commands are:

```text
npm run computer-use -- real-ax
npm run computer-use -- real-ax --scenario restart-recovery
npm run computer-use -- real-model
```
