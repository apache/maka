---
name: caching-strategy-optimizer
description: Optimizes CI/CD pipeline speed by implementing effective caching for dependencies, Docker layers, build outputs, and test results. Provides before/after performance metrics and best practices. Use for "CI caching", "pipeline optimization", "build speed", or "cache strategy".
---

# Caching Strategy Optimizer

Dramatically speed up CI pipelines with intelligent caching.

## Cache Key Strategy

### Package Manager Caches

```yaml
# NPM - Hash package-lock.json
- uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-npm-

# pnpm - More aggressive caching
- uses: pnpm/action-setup@v2
  with:
    version: 8

- uses: actions/cache@v3
  with:
    path: |
      ~/.pnpm-store
      node_modules
    key: ${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
    restore-keys: |
      ${{ runner.os }}-pnpm-

# Python pip
- uses: actions/cache@v3
  with:
    path: ~/.cache/pip
    key: ${{ runner.os }}-pip-${{ hashFiles('**/requirements.txt') }}

# Cargo/Rust
- uses: actions/cache@v3
  with:
    path: |
      ~/.cargo/bin/
      ~/.cargo/registry/index/
      ~/.cargo/registry/cache/
      ~/.cargo/git/db/
      target/
    key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}
```

## Docker Layer Caching

### Using Buildx

```yaml
- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@v3

- name: Build with cache
  uses: docker/build-push-action@v5
  with:
    context: .
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

### Registry-based Cache

```yaml
- name: Build with registry cache
  uses: docker/build-push-action@v5
  with:
    context: .
    cache-from: type=registry,ref=myapp:buildcache
    cache-to: type=registry,ref=myapp:buildcache,mode=max
```

## Build Output Caching

```yaml
# Next.js cache
- uses: actions/cache@v3
  with:
    path: |
      ${{ github.workspace }}/.next/cache
    key: ${{ runner.os }}-nextjs-${{ hashFiles('**/package-lock.json') }}-${{ hashFiles('**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx') }}
    restore-keys: |
      ${{ runner.os }}-nextjs-${{ hashFiles('**/package-lock.json') }}-
      ${{ runner.os }}-nextjs-

# Webpack cache
- uses: actions/cache@v3
  with:
    path: node_modules/.cache/webpack
    key: ${{ runner.os }}-webpack-${{ hashFiles('webpack.config.js') }}-${{ hashFiles('src/**') }}

# TypeScript build cache
- uses: actions/cache@v3
  with:
    path: |
      dist
      tsconfig.tsbuildinfo
    key: ${{ runner.os }}-tsc-${{ hashFiles('**/*.ts') }}
```

## Test Results Caching

```yaml
# Jest cache
- uses: actions/cache@v3
  with:
    path: /tmp/jest_rt
    key: ${{ runner.os }}-jest-${{ hashFiles('**/*.test.ts') }}

# Pytest cache
- uses: actions/cache@v3
  with:
    path: .pytest_cache
    key: ${{ runner.os }}-pytest-${{ hashFiles('**/*test*.py') }}
```

## Before/After Metrics

```markdown
## Before Optimization

- Total time: 12 minutes
- npm ci: 4 minutes
- Build: 5 minutes
- Tests: 3 minutes

## After Caching

- Total time: 3 minutes
- npm ci: 30 seconds (cache hit)
- Build: 1 minute (incremental)
- Tests: 1.5 minutes (cache hit)

**Improvement: 75% faster (12m → 3m)**
```

## Cache Hit Rate Monitoring

```yaml
- name: Check cache hit
  id: cache
  uses: actions/cache@v3
  with:
    path: node_modules
    key: ${{ runner.os }}-deps-${{ hashFiles('package-lock.json') }}

- name: Log cache status
  run: |
    if [ "${{ steps.cache.outputs.cache-hit }}" == "true" ]; then
      echo "✅ Cache hit - saved $(date -u -d @$SECONDS +%M:%S)"
    else
      echo "❌ Cache miss - installing from scratch"
    fi
```

## Best Practices

1. **Precise keys**: Include all dependencies in hash
2. **Restore keys**: Fallback to partial matches
3. **Multiple paths**: Cache related files together
4. **Size limits**: GitHub Actions limit is 10GB
5. **Expiration**: Caches expire after 7 days
6. **Mode=max**: Docker cache mode for better hits
7. **Monitor hits**: Track cache effectiveness

## Common Pitfalls

❌ **Too generic keys**: `key: deps` (always hits)
✅ **Specific keys**: `key: deps-${{ hashFiles('package-lock.json') }}`

❌ **Missing restore-keys**: Cache miss on minor changes
✅ **Restore keys**: Partial match fallback

❌ **Caching node_modules with wrong lock file**
✅ **Match lock file**: Hash the right lockfile

## Output Checklist

- [ ] Package manager cache configured
- [ ] Build output cache
- [ ] Docker layer cache (if applicable)
- [ ] Test cache configured
- [ ] Cache keys use file hashes
- [ ] Restore keys for fallback
- [ ] Before/after metrics documented
- [ ] Cache hit monitoring
