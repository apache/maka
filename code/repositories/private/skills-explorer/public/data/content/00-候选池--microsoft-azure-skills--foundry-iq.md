---
name: foundry-iq
description: "Foundry IQ knowledge bases. WHEN: make local or Blob documents searchable; create/diagnose KBs; triage unsupported connectors or multi-source KB creation/reconfiguration; connect existing KB to agents (including multi-source KBs); create/reuse a Search service; retrieve from an existing knowledge base with citations; no brand words needed. Read its procedure before query/target questions. NOT: other KB providers, repository-file search, classic Azure AI Search index/query/app work, generic agent creation."
license: MIT
compatibility: Azure
metadata:
  author: Microsoft
  version: "0.1.2"
---

# Foundry IQ

Read one procedure before questions/actions; invocation is not a read.
Read the owning procedure before blocked/unsupported responses too.
Before mutation plans/approval, successfully read its required pre-action references, selected
branches only. Do not reload successful reads. On failure, try only permitted
bounded exact-path reads with any supported reader; never bypass restrictions
or search broadly. If still unavailable: `blocked: reference-unavailable`, name
missing references and inability to plan. Never invent requirements/plans.
Failures first.

Cleanup and receipt-backed execution go directly to their lifecycle/producer owner;
do not reopen Search intake, provisioning or hardening.

Before expensive service discovery, reuse supplied resource/intent; otherwise ask
one early **USE EXISTING / FIND CANDIDATES / CREATE NEW** choice.
Only FIND enumerates; supplied identity uses exact/minimum scoped resolution.
CREATE checks its proposed name, not existing-service inventories. Preserve these
answers across source/KB/CU/model handoffs; selection is not write approval.

Searchable docs: KB + validated retrieval. Confirm intent once; KS-only must be explicit.
Child success is not KB completion.
Unclear/compound/mode/completion: [read](references/intent-routing.md).

Route by requested operation, not existing KB source count.
Connecting an existing KB with two or more sources, without changing the KB, uses Connect.
Read-only operations use their owning procedure and actual helper constraints;
this does not add retrieval modes or supported source kinds.
Explicit unsupported provisioning or multi-source KB creation/reconfiguration uses Diagnose
and stops before discovery, even when connecting an agent is also requested.
Do not silently execute only the supported part of a compound request.
If existing-KB connection versus KB creation/reconfiguration is unclear, read
intent-routing and clarify that scope before Azure discovery. Never infer KB mutation.

| Outcome                                                                          | Read                                           |
| -------------------------------------------------------------------------------- | ---------------------------------------------- |
| Cleanup                                                                          | [Plan cleanup](lifecycle/cleanup.md)           |
| Failure/drift                                                                    | [Diagnose](troubleshooting/diagnose.md)        |
| Unsupported connector provisioning / multi-source KB creation or reconfiguration | [Diagnose](troubleshooting/diagnose.md)        |
| Connect                                                                          | [Connect](agents/connect.md)                   |
| Read KB                                                                          | [Query](knowledge-bases/retrieve.md)           |
| Search only                                                                      | [Search](search-services/create.md)            |
| File KS only                                                                     | [File](knowledge-sources/create-file.md)       |
| Blob/ADLS KS only                                                                | [Blob](knowledge-sources/create-azure-blob.md) |
| Searchable/KB                                                                    | [KB](knowledge-bases/create.md)                |

Generic agents: `microsoft-foundry`.
Reads: no approval; approve unchanged plans before writes.
Hide hashes. No Search/Storage keys, scope widening, guessed identity/boundaries,
drift repair or joint cleanup/creation approval. Acceptance != success.
