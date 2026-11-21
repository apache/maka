---
name: rollback-workflow-builder
description: Creates safe rollback procedures for deployments with automated workflows, rollback runbooks, version management, and incident response. Use for "rollback automation", "deployment recovery", "incident response", or "production rollback".
---

# Rollback Workflow Builder

Build safe, fast rollback mechanisms for production deployments.

## Manual Rollback Workflow

```yaml
# .github/workflows/rollback.yml
name: Rollback

on:
  workflow_dispatch:
    inputs:
      version:
        description: "Version to rollback to (e.g., v1.2.3 or previous)"
        required: true
        type: string
      environment:
        description: "Environment to rollback"
        required: true
        type: choice
        options:
          - staging
          - production
      reason:
        description: "Reason for rollback"
        required: true
        type: string

jobs:
  rollback:
    runs-on: ubuntu-latest
    environment: ${{ github.event.inputs.environment }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.inputs.version }}

      - name: Verify version exists
        run: |
          if ! git rev-parse ${{ github.event.inputs.version }} >/dev/null 2>&1; then
            echo "❌ Version ${{ github.event.inputs.version }} not found"
            exit 1
          fi
          echo "✅ Version ${{ github.event.inputs.version }} exists"

      - name: Get current version
        id: current
        run: |
          CURRENT=$(git describe --tags --abbrev=0)
          echo "version=$CURRENT" >> $GITHUB_OUTPUT
          echo "Current version: $CURRENT"

      - name: Confirm rollback
        run: |
          echo "🔄 Rolling back from ${{ steps.current.outputs.version }} to ${{ github.event.inputs.version }}"
          echo "Environment: ${{ github.event.inputs.environment }}"
          echo "Reason: ${{ github.event.inputs.reason }}"

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - run: npm ci
      - run: npm run build

      - name: Deploy rollback
        run: |
          ./scripts/deploy.sh ${{ github.event.inputs.environment }}
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}

      - name: Verify deployment
        run: |
          ./scripts/health-check.sh ${{ github.event.inputs.environment }}

      - name: Create incident issue
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `Rollback: ${context.payload.inputs.environment} to ${context.payload.inputs.version}`,
              body: `## Rollback Details

              **Environment:** ${context.payload.inputs.environment}
              **From:** ${{ steps.current.outputs.version }}
              **To:** ${context.payload.inputs.version}
              **Reason:** ${context.payload.inputs.reason}
              **Triggered by:** @${context.actor}
              **Time:** ${new Date().toISOString()}

              ## Next Steps
              - [ ] Verify rollback successful
              - [ ] Investigate root cause
              - [ ] Create fix
              - [ ] Update postmortem
              `,
              labels: ['incident', 'rollback']
            })
```

## Automated Rollback on Failure

```yaml
deploy:
  runs-on: ubuntu-latest
  steps:
    - name: Deploy
      id: deploy
      run: ./scripts/deploy.sh production
      continue-on-error: true

    - name: Verify deployment
      id: verify
      if: steps.deploy.outcome == 'success'
      run: ./scripts/health-check.sh production
      continue-on-error: true

    - name: Auto-rollback on failure
      if: steps.deploy.outcome == 'failure' || steps.verify.outcome == 'failure'
      run: |
        echo "⚠️ Deployment failed, initiating automatic rollback"
        PREVIOUS_VERSION=$(git describe --tags --abbrev=0 HEAD^)
        ./scripts/deploy.sh production $PREVIOUS_VERSION

        # Verify rollback
        if ./scripts/health-check.sh production; then
          echo "✅ Rollback successful"
        else
          echo "❌ Rollback failed - manual intervention required"
          exit 1
        fi
```

## Kubernetes Rollback

```yaml
rollback-k8s:
  runs-on: ubuntu-latest
  steps:
    - name: Setup kubectl
      uses: azure/setup-kubectl@v3

    - name: Configure kubectl
      run: |
        echo "${{ secrets.KUBECONFIG }}" > kubeconfig
        export KUBECONFIG=kubeconfig

    - name: Rollback deployment
      run: |
        kubectl rollout undo deployment/myapp -n production
        kubectl rollout status deployment/myapp -n production --timeout=5m

    - name: Get rollback revision
      run: |
        kubectl rollout history deployment/myapp -n production
```

## Docker Image Rollback

```yaml
- name: Rollback to previous image
  run: |
    # Get previous image tag
    PREVIOUS_TAG=$(docker inspect myapp:latest | jq -r '.[0].ContainerConfig.Labels.previous_tag')

    # Retag previous as latest
    docker pull myapp:$PREVIOUS_TAG
    docker tag myapp:$PREVIOUS_TAG myapp:latest
    docker push myapp:latest

    # Restart containers
    docker-compose pull
    docker-compose up -d
```

## Database Migration Rollback

```yaml
- name: Rollback database migrations
  run: |
    # Get migration to rollback to
    CURRENT=$(npm run migrate:current)
    TARGET=${{ github.event.inputs.migration }}

    echo "Rolling back from $CURRENT to $TARGET"
    npm run migrate:down -- --to=$TARGET

    # Verify rollback
    AFTER=$(npm run migrate:current)
    if [ "$AFTER" != "$TARGET" ]; then
      echo "❌ Migration rollback failed"
      exit 1
    fi
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

## Rollback Runbook

````markdown
# Production Rollback Runbook

## When to Rollback

Rollback if:

- Critical bugs affecting >10% of users
- Data integrity issues
- Security vulnerabilities
- Performance degradation >50%
- Error rate >5%

## Before Rollback

1. **Assess impact**: Check monitoring dashboards
2. **Identify version**: Determine last known good version
3. **Notify team**: Post in #incidents Slack channel
4. **Enable maintenance mode** (if possible)

## Rollback Steps

### Automated Rollback (Preferred)

1. Go to Actions → Rollback workflow
2. Select environment (staging/production)
3. Enter target version (e.g., v1.2.3 or "previous")
4. Enter reason for rollback
5. Click "Run workflow"
6. Monitor progress in Actions tab

### Manual Rollback (Emergency)

```bash
# 1. SSH to production server
ssh production

# 2. Check current version
docker ps | grep myapp

# 3. Pull previous version
docker pull myapp:v1.2.3

# 4. Update docker-compose
vim docker-compose.yml
# Change image: myapp:latest to myapp:v1.2.3

# 5. Deploy
docker-compose up -d

# 6. Verify
curl https://api.myapp.com/health

# 7. Check logs
docker logs myapp -f
```
````

## After Rollback

1. **Verify**: Run smoke tests
2. **Monitor**: Watch error rates for 15 minutes
3. **Notify**: Update #incidents with status
4. **Disable maintenance mode**
5. **Create incident ticket**
6. **Schedule postmortem**

## Rollback Verification

- [ ] Health check returns 200
- [ ] Error rate <1%
- [ ] Response time p95 <500ms
- [ ] Key features working (login, checkout, etc.)
- [ ] Database connectivity OK

## Communication Template

```
🔄 ROLLBACK IN PROGRESS

Environment: Production
From: v1.3.0
To: v1.2.3
Reason: Critical bug in checkout flow
Status: In progress
ETA: 5 minutes

Updates: #incidents
```

## Common Issues

### Issue: Rollback Fails

**Symptom:** Deployment doesn't start
**Fix:** Check logs, verify version exists, ensure secrets are valid

### Issue: Database Incompatibility

**Symptom:** App starts but can't read data
**Fix:** May need to rollback migrations first

### Issue: Traffic Not Routing

**Symptom:** Users still see new version
**Fix:** Clear CDN cache, check load balancer config

````

## Health Check Script

```bash
#!/bin/bash
# scripts/health-check.sh

ENVIRONMENT=$1
BASE_URL="https://${ENVIRONMENT}.myapp.com"

echo "Running health checks for $ENVIRONMENT..."

# API health
if ! curl -f "$BASE_URL/api/health" > /dev/null 2>&1; then
  echo "❌ API health check failed"
  exit 1
fi

# Database connection
if ! curl -f "$BASE_URL/api/health/db" > /dev/null 2>&1; then
  echo "❌ Database health check failed"
  exit 1
fi

# Key endpoints
ENDPOINTS=("/api/users" "/api/products" "/api/orders")
for endpoint in "${ENDPOINTS[@]}"; do
  if ! curl -f "$BASE_URL$endpoint" > /dev/null 2>&1; then
    echo "❌ Endpoint $endpoint health check failed"
    exit 1
  fi
done

echo "✅ All health checks passed"
exit 0
````

## Best Practices

1. **Fast rollback**: <5 minutes to previous version
2. **Automated**: One-click rollback workflow
3. **Verified**: Health checks after rollback
4. **Documented**: Clear runbook
5. **Tested**: Practice rollbacks regularly
6. **Monitored**: Alert on failures
7. **Communicated**: Notify stakeholders

## Output Checklist

- [ ] Manual rollback workflow
- [ ] Automated rollback on failure
- [ ] Platform-specific rollback (K8s/Docker)
- [ ] Database rollback procedure
- [ ] Rollback runbook documented
- [ ] Health check scripts
- [ ] Communication templates
- [ ] Incident issue automation
