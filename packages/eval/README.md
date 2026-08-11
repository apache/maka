# @maka/eval

`@maka/eval` owns experiment semantics. It does not execute Maka or construct Runtime objects.

```text
Experiment → Cells → Attempts → Results
                    ↓
       Runtime Host executes Maka subjects
```

An Experiment combines one benchmark, one executor, all subjects, all tasks, a repetition count, one shared budget, one verifier, and a frozen task-group concurrency limit. Cells are the Cartesian product `task × repetition × subject`. All subject arms in one task repetition start together; independent task groups run up to the declared limit. A repetition is a new experimental sample; an infrastructure retry appends a replacement attempt to the same cell; continuation remains internal to Runtime Host. Each subject declares only the credential environment names its cells receive.

Run a fully expanded spec through the public CLI:

```sh
maka eval run experiment.json --out .maka-eval/run-001
```

Use `--cell <cell-id>` to replace one failed or indeterminate cell. The attempt log is append-only and result selection always uses the earliest valid attempt.

The built-in Harbor and Pier executors use one relay Agent. The framework prepares the task environment, the relay invokes exactly one Eval subject from `Agent.run()`, and the framework runs its native verifier and finalizer. Harbor and Pier use separate, explicitly versioned Python environments because their Agent and task contracts differ.

Maka subjects ask the Runtime Host client to run one owned execution in a dedicated Host root. Session, Turn, Goal and continuation semantics remain inside Runtime Host. External subjects declare only a command and arguments; cohort-specific wrappers may configure the external product, but do not gain Runtime authority.

The result kernel contains only score, normalized usage, attributable cost, duration, status, and artifacts. Specs carry every semantic setting; environment variables are reserved for credentials and machine-local paths.

The checked-in Terminal-Bench 2.1 four-arm cohort is `experiments/terminal-bench-2.1-deepseek-v4-flash-four-arm.json`. It freezes provider endpoints, framework version, container paths and read-only mount policy. Set each declared machine-path environment variable to its trusted prepared directory, and set the declared API-key credentials. Machine-local paths select artifacts; they do not alter experiment semantics and are not presented as a cryptographic identity scheme.

The experiment directory contains the frozen `experiment.json` and append-only attempt records. There is no second mutable results file. A leftover `.writer.lock` means the previous writer did not complete; remove it only after proving that no writer process remains.
