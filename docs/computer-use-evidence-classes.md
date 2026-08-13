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
