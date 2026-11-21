---
name: azure-cloud-migrate
description: "Assess and migrate cross-cloud workloads to Azure with reports and code conversion. Supports Lambda→Functions, Beanstalk/Heroku/App Engine→App Service, Fargate/Kubernetes/Cloud Run/Spring Boot→Container Apps. WHEN: migrate Lambda to Functions, AWS to Azure, migrate Beanstalk, migrate Heroku, migrate App Engine, Cloud Run migration, Fargate to ACA, ECS/Kubernetes/GKE/EKS to Container Apps, Spring Boot to Container Apps, cross-cloud migration."
license: MIT
metadata:
  author: Microsoft
  version: "1.3.2"
---

# Azure Cloud Migrate

> This skill handles **assessment and code migration** of existing cloud workloads to Azure.

## Rules

1. Follow phases sequentially — do not skip
2. Generate assessment before any code migration
3. Load the scenario reference and follow its rules
4. Use `mcp_azure_mcp_get_azure_bestpractices` and `mcp_azure_mcp_documentation` MCP tools
5. Use the latest supported runtime for the target service
6. Destructive actions require `ask_user` — [functions global-rules](references/services/functions/global-rules.md) | [app-service global-rules](references/services/app-service/global-rules.md)
7. **Report progress to user** — During long-running operations (deployments, image pushes), provide resource-level status updates so the user is never left waiting without feedback — see [workflow-details.md](references/workflow-details.md)
8. **Audit service discovery in app code** — Kubernetes DNS names (e.g., `http://order-service:3001`) do not resolve in Container Apps. During assessment, scan source code for hardcoded hostnames/ports in HTTP clients and flag them for env-var-driven URL injection

## Migration Scenarios

| Source                              | Target               | Reference                                                                                                                                                                                                                                                    |
| ----------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS Lambda                          | Azure Functions      | [lambda-to-functions.md](references/services/functions/lambda-to-functions.md) ([assessment](references/services/functions/assessment.md), [code-migration](references/services/functions/code-migration.md))                                                |
| AWS Elastic Beanstalk               | Azure App Service    | [beanstalk-to-app-service.md](references/services/app-service/beanstalk-to-app-service.md)                                                                                                                                                                   |
| Heroku                              | Azure App Service    | [heroku-to-app-service.md](references/services/app-service/heroku-to-app-service.md)                                                                                                                                                                         |
| Google App Engine                   | Azure App Service    | [app-engine-to-app-service.md](references/services/app-service/app-engine-to-app-service.md)                                                                                                                                                                 |
| AWS Fargate (ECS)                   | Azure Container Apps | [fargate-to-container-apps.md](references/services/container-apps/fargate-to-container-apps.md) ([assessment](references/services/container-apps/fargate-assessment-guide.md), [deployment](references/services/container-apps/fargate-deployment-guide.md)) |
| Kubernetes (GKE/EKS/Self-hosted)    | Azure Container Apps | [k8s-to-container-apps.md](references/services/container-apps/k8s-to-container-apps.md)                                                                                                                                                                      |
| GCP Cloud Run                       | Azure Container Apps | [cloudrun-to-container-apps.md](references/services/container-apps/cloudrun-to-container-apps.md)                                                                                                                                                            |
| Spring Boot (Azure Spring Apps/VMs) | Azure Container Apps | [spring-apps-to-aca.md](references/services/container-apps/spring-apps-to-aca.md)                                                                                                                                                                            |

> No matching scenario? Use `mcp_azure_mcp_documentation` and `mcp_azure_mcp_get_azure_bestpractices` tools.

## Output Directory

All output goes to `<workspace-root-basename>-azure/` at workspace root, where `<workspace-root-basename>` is the name of the top-level workspace directory itself (NOT a subdirectory within it). Never modify the source directory.

## Steps

1. **Create** `<workspace-root-basename>-azure/` at workspace root
2. **Assess** — Analyze source, map services, generate report using the scenario-specific assessment guide → [functions assessment](references/services/functions/assessment.md) | [app-service assessment](references/services/app-service/assessment.md)
3. **Migrate** — Convert code/config using the scenario-specific migration guide → [functions code-migration](references/services/functions/code-migration.md) | [app-service code-migration](references/services/app-service/code-migration.md)
4. **Ask User** — "Migration complete. Test locally or deploy to Azure?"
5. **Hand off** to azure-prepare for infrastructure, testing, and deployment

Track progress in `migration-status.md` — see [workflow-details.md](references/workflow-details.md).
