---
name: neural-mechanism-research
description: Research why neural architectures and training methods work through forward computation, geometry, gradients, optimization dynamics, historical experiments, and competing explanations. Use for deep mechanism questions about neural networks, AI models, layers, representations, or training; explain the meaning in plain language with evidence and explicit limits.
---

# Neural Mechanism Research

Explain what the computation actually makes possible, how learning discovers it, and how firmly the explanation is established. The reader should be able to reconstruct a small example and predict what would change if the design changed.

This is a neural-computation variant of `deep-architecture-research` combined with the reporting principles of `understanding-first-report`. The essential guidance is self-contained here; neither skill has to be loaded again. Use their deeper references only if the task also requires a substantial source-code audit or a separate reporting review.

## Start with the real question

Quote the relevant original user wording before substantive analysis. For a long prompt, preserve the central questions and mark omissions. Reconstruct the underlying puzzle, including the user's proposed explanation, rather than replacing it with a generic survey.

Map the few causal relationships that matter. For example:

```text
architecture / parameterization
          │
          ├── forward: what functions become possible?
          ├── geometry: what changes, mixes, or becomes separable?
          └── backward: which errors change which parameters?
                         │
data / loss / optimizer ─┘
                         ▼
              learned behavior and cost
                         │
              evidence and alternatives
```

If the user has provided clear scope and requested research, state the interpretation and proceed. Clarify only material ambiguity. Do not introduce a repeated confirmation gate or reopen accepted scope.

## Treat meaning as a testable explanation

For the main mechanism, connect these perspectives rather than filling six disconnected sections:

- **Forward computation:** concrete inputs, shapes, parameters, intermediate states, outputs, and what the next component can do with them.
- **Geometry and information:** projections, rank, basis changes, nonlinear boundaries, mixing, routing, compression, invariances, and the distinction between coordinate count and independent information.
- **Backward computation:** start at the actual objective, follow the chain rule to the relevant parameters, and explain what an update rewards or suppresses.
- **Learning dynamics:** initialization, symmetry breaking, feature learning, gradient conflicts, saturation, conditioning, optimization noise, and dependence on the parameterization.
- **Physical or dynamical interpretations:** use energy, attractors, diffusion, discrete dynamics, or other physical language only where the equations justify the mapping. State which assumptions make it valid and where it breaks.
- **Engineering and history:** distinguish a useful inductive bias from an empirically selected size, implementation convenience, resource tradeoff, or historical convention.

Use only the perspectives that change the answer, but do not omit gradients, geometry, or historical limitations when they are central to the user's puzzle.

### Explain the explanation

For each decisive claim, make this chain understandable:

```text
ordinary-language meaning → tiny example → exact mechanism
                                   │
                       evidence / counterexample / limit
```

An analogy must map to actual variables or operations. “More capacity,” “richer features,” “knowledge lookup,” and “better gradients” are starting questions, not completed explanations. Explain what capacity counts, how features are selected, where a stored relation is encoded, or which derivative changes.

Prefer low prerequisite explanations without sacrificing correctness. Show real shapes alongside small examples. A two-dimensional sketch is a teaching abstraction, not a literal picture of a high-dimensional learned space.

## Gather evidence across time and alternatives

For substantial research, read [references/evidence-and-experiments.md](references/evidence-and-experiments.md). It supplies the historical comparison method, gradient checks, and causal-evidence boundaries.

Use primary papers, original implementations, released model configurations, and author research reports. Pin the version or date for decisive sources. Separate the original motivation from later explanations and present-day engineering choices.

When the mechanism has a long history, follow the chain from precursors to initial experiments, later ablations, conflicting results, and successful variants. Do not pad the history to meet a paper count. A decade-scale question deserves a decade-scale comparison, not a list of recent papers.

For each material disagreement, determine whether the papers changed the task, metric, scale, compute budget, optimizer, training duration, model family, intervention, or definition. A change in conditions can reconcile apparently contradictory results; unresolved disagreement stays unresolved.

Do not infer consensus from citation counts or implementation popularity. Distinguish:

- exact algebra or a theorem under stated assumptions;
- replicated or converging empirical evidence;
- a result observed in one experimental setting;
- a plausible mechanistic hypothesis;
- a pedagogical analogy;
- an open question.

## Compare designs under an explicit budget

Before saying that a design is better, name what is fixed: total parameters, active parameters, training tokens, training FLOPs, inference latency, memory, or wall-clock time.

Trace whether the alternative changes the mathematical function, the learnable function family, parameter sharing, optimizer behavior, or just the implementation. A reshape by itself does not create a new mechanism.

Track costs hidden by big-O notation, including softmax operations, activation storage, KV-cache traffic, parallelism, serial depth, and hardware utilization when relevant.

Treat default widths, head counts, expansion ratios, and training recipes as testable choices. Do not turn a successful local experiment into a universal optimum, or the lack of a proof into a claim that the original researchers chose randomly.

## Use small experiments for bounded claims

When a derivation or proposed explanation can be checked cheaply, construct a minimal counterexample, compute the relevant Jacobian, or compare automatic differentiation with a hand-derived gradient.

Report what the experiment establishes and what it does not. A toy example can refute “splitting alone improves gradients”; it cannot establish which model learns best at frontier scale. Do not replace literature coverage with a toy experiment or claim to have reproduced training that was not run.

Keep work within the user's authorized scope. Create a research artifact when requested or appropriate to the invoked deep-research workflow; avoid unrelated edits, expensive training, or changes to existing projects.

## Report one coherent mechanism

The chat answer should stand on its own. Use a short main path, then deepen the specific issues the user asked about; a long question may warrant substantial detail. A linked report can hold the derivations and evidence without becoming a substitute for the answer.

Usually lead with:

1. The original-question anchor and the central conclusion.
2. A whole-process diagram with the few meaningful dimensions.
3. The mechanism, including the strongest correction to the user's hypothesis.
4. The evidence that survives historical comparison, and the limits that matter.
5. What remains uncertain and the smallest experiment that would resolve it.

Adapt this order to the reader. Do not force a template, bury the answer under paper summaries, or narrate the search log. Place sources beside the claims they support.

## Completion standard

The answer is ready when every material user question is answered or explicitly open; the central mechanism can be reconstructed from the explanation; mathematical facts, measurements, and hypotheses remain distinct; serious counterevidence is included; and practical conclusions name their budgets and uncertainty.

Check especially for these failures:

- equating width with information, neuron count with fact count, or gradient norm with useful learning;
- treating attention weights, activation correlations, linear probes, ablations, and weight edits as equivalent causal evidence;
- assigning fixed human meanings to coordinates, heads, or neurons without evidence;
- extrapolating a theorem beyond its hypotheses or a small-model result to all LLMs;
- claiming a physical law for a convenient mathematical analogy;
- explaining a historical design entirely through later interpretability work;
- treating trained-model pruning as proof that the smaller model would train equally well from scratch.
