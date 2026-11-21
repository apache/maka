---
name: paper-context-resolver
description: Rigor Paper Context helper for README-first deep learning repo reproduction. Use only when the README and repository files leave a narrow reproduction-critical gap and the task is to resolve a specific paper detail such as dataset split, preprocessing, evaluation protocol, checkpoint mapping, or runtime assumption from primary paper sources while recording conflicts. Do not use for general paper summary, repo scanning, environment setup, command execution, title-only paper lookup, or replacing README guidance by default.
---

# paper-context-resolver

Use this as the Rigor Paper Context helper. The installed slug remains
`paper-context-resolver` for compatibility.

## When to apply

- README and repo files leave a reproduction-critical gap.
- The gap concerns dataset version, split, preprocessing, evaluation protocol, checkpoint mapping, or runtime assumptions.
- The main skill needs a narrow evidence supplement instead of a full paper summary.
- There is already a concrete reproduction question to answer.

## When not to apply

- The README already gives enough reproduction detail.
- The user wants a general paper explanation rather than reproduction support.
- The goal is to override README instructions without documenting the conflict.
- The only available input is a paper title and there is no concrete reproduction gap yet.

## Clear boundaries

- This skill is optional.
- This skill is helper-tier and should usually be orchestrator-invoked.
- It supplements README-first reproduction.
- It does not replace the main orchestration flow.
- It does not summarize the whole paper by default.

## Input expectations

- target repo metadata
- reproduction-critical question
- existing README or repo evidence
- any already known paper links

## Output expectations

- narrowed source list
- reproduction-relevant answer only
- explicit README-paper conflict note when applicable
- clear distinction between direct evidence and inference

## Notes

Use `references/paper-assisted-reproduction.md`.
