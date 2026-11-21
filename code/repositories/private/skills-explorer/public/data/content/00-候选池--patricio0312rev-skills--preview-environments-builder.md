---
name: preview-environments-builder
description: Creates ephemeral preview deployments for each pull request with automatic deployment, unique URLs, and cleanup on PR close. Use for "preview deployments", "PR environments", "ephemeral environments", or "review apps".
---

# Preview Environments Builder

Deploy isolated preview environments for every pull request.

## Vercel Preview Deployment

```yaml
# .github/workflows/preview.yml
name: Preview Deployment

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  deploy-preview:
    runs-on: ubuntu-latest
    environment:
      name: preview-${{ github.event.pull_request.number }}
      url: ${{ steps.deploy.outputs.url }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - run: npm ci
      - run: npm run build

      - name: Deploy to Vercel
        id: deploy
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          scope: ${{ secrets.VERCEL_ORG_ID }}
          alias-domains: pr-${{ github.event.pull_request.number }}.myapp.dev

      - name: Comment PR
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `✅ Preview deployed!\n\n🔗 **URL:** ${{ steps.deploy.outputs.url }}\n\nCommit: ${context.sha.substring(0, 7)}`
            })
```

## Docker-based Preview

```yaml
preview:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - name: Build Docker image
      run: |
        docker build -t myapp:pr-${{ github.event.pull_request.number }} .

    - name: Deploy to Kubernetes
      run: |
        kubectl create namespace pr-${{ github.event.pull_request.number }} || true
        kubectl apply -f k8s/preview.yml \
          --namespace pr-${{ github.event.pull_request.number }}
        kubectl set image deployment/myapp \
          myapp=myapp:pr-${{ github.event.pull_request.number }} \
          --namespace pr-${{ github.event.pull_request.number }}

    - name: Get preview URL
      id: url
      run: |
        URL=$(kubectl get ingress myapp \
          --namespace pr-${{ github.event.pull_request.number }} \
          -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
        echo "url=https://pr-${{ github.event.pull_request.number }}.preview.myapp.com" >> $GITHUB_OUTPUT

    - name: Comment PR
      uses: actions/github-script@v7
      with:
        script: |
          github.rest.issues.createComment({
            issue_number: context.issue.number,
            owner: context.repo.owner,
            repo: context.repo.repo,
            body: `🚀 Preview deployed to: ${{ steps.url.outputs.url }}`
          })
```

## Cleanup on PR Close

```yaml
# .github/workflows/cleanup-preview.yml
name: Cleanup Preview

on:
  pull_request:
    types: [closed]

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Delete Vercel deployment
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const deployments = await github.rest.repos.listDeployments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              environment: `preview-${context.issue.number}`
            });

            for (const deployment of deployments.data) {
              await github.rest.repos.createDeploymentStatus({
                owner: context.repo.owner,
                repo: context.repo.repo,
                deployment_id: deployment.id,
                state: 'inactive'
              });

              await github.rest.repos.deleteDeployment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                deployment_id: deployment.id
              });
            }

      - name: Cleanup Kubernetes namespace
        run: |
          kubectl delete namespace pr-${{ github.event.pull_request.number }} --ignore-not-found=true
```

## Environment Naming

```yaml
# Consistent naming pattern
environment:
  name: preview-pr-${{ github.event.pull_request.number }}
  url: https://pr-${{ github.event.pull_request.number }}.preview.myapp.com
```

## Database Seeding

```yaml
- name: Setup preview database
  run: |
    # Create database
    psql -c "CREATE DATABASE preview_pr_${{ github.event.pull_request.number }};"

    # Seed with test data
    npm run db:seed -- --database=preview_pr_${{ github.event.pull_request.number }}
  env:
    DATABASE_URL: ${{ secrets.PREVIEW_DB_URL }}
```

## Best Practices

1. **Unique URLs**: pr-{number}.preview.domain.com
2. **Auto cleanup**: Delete on PR close
3. **Comment on PR**: Link to preview
4. **Environment protection**: Require approval
5. **Resource limits**: Prevent abuse
6. **TTL**: Auto-delete after 7 days
7. **Secrets management**: Use preview-specific secrets

## Output Checklist

- [ ] Preview deployment workflow
- [ ] Unique URL generation
- [ ] PR comment with link
- [ ] Cleanup workflow on close
- [ ] Environment naming strategy
- [ ] Database seeding (if needed)
- [ ] Resource limits configured
