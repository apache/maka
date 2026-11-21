---
name: finetuning
description: "Fine-tune models on Microsoft Foundry using SFT (supervised), DPO (preference), or RFT (reinforcement with graders). Covers dataset preparation, training job submission, deployment, and evaluation. USE FOR: fine-tune, SFT, DPO, RFT, training data, grader, distillation, fine-tuned model, training job, large file upload, calibrate grader, deploy fine-tuned model, evaluate fine-tuned model. DO NOT USE FOR: general model deployment without fine-tuning (use deploy-model), agent creation (use agents), prompt optimization without training (use prompt-optimizer)."
license: MIT
metadata:
  author: Microsoft
  version: "0.0.0-placeholder"
---

# Fine-Tuning on Microsoft Foundry

Fine-tune models using SFT (supervised), DPO (preference), or RFT (reinforcement with graders). Covers dataset prep, training, deployment, and evaluation.

## When to Use

Use this sub-skill when the user asks about:

- Fine-tuning a model (SFT, DPO, or RFT)
- Preparing, validating, or formatting training data
- Submitting, monitoring, or diagnosing training jobs
- Calibrating graders or pass thresholds for RFT
- Deploying or evaluating a fine-tuned model
- Choosing between training types (SFT vs DPO vs RFT)
- Distillation, synthetic data generation, or dataset quality scoring
- Large file uploads for training data
- Cleaning up fine-tuning resources (files, deployments)

**Do NOT use for:** General model deployment without fine-tuning (use deploy-model), agent creation (use agents), prompt optimization without training (use prompt-optimizer).

## Workflows

| Stage             | Guide                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| **Quick start**   | [workflows/quickstart.md](workflows/quickstart.md)                       |
| **Full pipeline** | [workflows/full-pipeline.md](workflows/full-pipeline.md)                 |
| **Create data**   | [workflows/dataset-creation.md](workflows/dataset-creation.md)           |
| **Iterate**       | [workflows/iterative-training.md](workflows/iterative-training.md)       |
| **Diagnose**      | [workflows/diagnose-poor-results.md](workflows/diagnose-poor-results.md) |

## References

| Topic               | File                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| SFT vs DPO vs RFT   | [references/training-types.md](references/training-types.md)         |
| Hyperparameters     | [references/hyperparameters.md](references/hyperparameters.md)       |
| Data formats        | [references/dataset-formats.md](references/dataset-formats.md)       |
| Grader design (RFT) | [references/grader-design.md](references/grader-design.md)           |
| Reward hacking      | [references/reward-hacking.md](references/reward-hacking.md)         |
| Agentic RFT (tools) | [references/agentic-rft.md](references/agentic-rft.md)               |
| Deployment          | [references/deployment.md](references/deployment.md)                 |
| Training curves     | [references/training-curves.md](references/training-curves.md)       |
| Evaluation          | [references/evaluation.md](references/evaluation.md)                 |
| Vision fine-tuning  | [references/vision-fine-tuning.md](references/vision-fine-tuning.md) |
| Large file uploads  | [references/large-file-uploads.md](references/large-file-uploads.md) |
| Platform gotchas    | [references/platform-gotchas.md](references/platform-gotchas.md)     |

## Scripts

| Script                                  | Purpose                                 |
| --------------------------------------- | --------------------------------------- |
| `scripts/submit_training.py`            | Submit SFT/DPO/RFT jobs                 |
| `scripts/monitor_training.py`           | Poll job until completion               |
| `scripts/calibrate_grader.py`           | Find optimal RFT pass_threshold         |
| `scripts/check_training.py`             | Analyze curves, list checkpoints        |
| `scripts/deploy_model.py`               | Deploy via ARM REST API                 |
| `scripts/evaluate_model.py`             | LLM judge evaluation                    |
| `scripts/convert_dataset.py`            | Convert between SFT/DPO/RFT formats     |
| `scripts/generate_distillation_data.py` | Generate synthetic training data        |
| `scripts/score_dataset.py`              | Quality scoring on training data        |
| `scripts/cleanup.py`                    | Delete old files and deployments        |
| `scripts/validate/`                     | Data validators (SFT, DPO, RFT) + stats |

## Rules

1. **Always baseline first** — evaluate the base model before fine-tuning
2. **Validate data** before submitting — run `scripts/validate/validate_sft.py`
3. **Calibrate RFT graders** — target 25-50% failure rate on the base model
4. **Evaluate checkpoints** — don't blindly deploy the final one
5. **Measure token cost** alongside accuracy when comparing models

## Quick Reference

| Task              | Command                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Validate SFT data | `python scripts/validate/validate_sft.py data.jsonl`                                                                        |
| Submit SFT job    | `python scripts/submit_training.py --model gpt-4.1-mini --training-file train.jsonl --validation-file val.jsonl --type sft` |
| Monitor job       | `python scripts/monitor_training.py --job-id ftjob-xxx`                                                                     |
| Analyze curves    | `python scripts/check_training.py --job-id ftjob-xxx`                                                                       |
| Deploy model      | `python scripts/deploy_model.py --model-id ft:gpt-4.1-mini:... --name my-eval`                                              |
| Evaluate model    | `python scripts/evaluate_model.py --deployment-name my-eval --test-file test.jsonl`                                         |

## Error Handling

| Error                                                     | Cause                                 | Fix                                             |
| --------------------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| "API version not supported"                               | Older `openai` SDK on `/v1/` endpoint | Upgrade to `openai>=1.0`                        |
| "does not support fine-tuning with Standard TrainingType" | OSS model needs `globalStandard`      | Use `--use-rest` flag or script auto-falls back |
| Job stuck in post-training eval                           | Under-provisioned tool endpoint (RFT) | Scale to S2+, enable Always On                  |
| "DeploymentNotReady" after ARM succeeds                   | ARM/data-plane race condition         | Delete and recreate deployment, wait 5 min      |
| Content safety block at deployment                        | PII-dense training data               | Remove problematic document types               |
