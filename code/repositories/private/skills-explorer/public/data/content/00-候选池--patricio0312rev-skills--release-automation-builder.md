---
name: release-automation-builder
description: Automates releases and package publishing with changesets or semantic-release. Handles versioning, changelog generation, git tags, and release notes. Use for "release automation", "semantic versioning", "package publishing", or "changelog generation".
---

# Release Automation Builder

Automate releases with versioning, changelogs, and publishing.

## Using Changesets

### Setup

```bash
npm install -D @changesets/cli
npx changeset init
```

### Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    branches:
      - main

concurrency: ${{ github.workflow }}-${{ github.ref }}

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - run: npm ci

      - name: Create Release Pull Request or Publish
        uses: changesets/action@v1
        with:
          publish: npm run release
          commit: "chore: release packages"
          title: "chore: release packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Package Scripts

```json
{
  "scripts": {
    "changeset": "changeset",
    "version": "changeset version",
    "release": "changeset publish"
  }
}
```

## Using Semantic Release

### Configuration

```javascript
// .releaserc.js
module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    "@semantic-release/npm",
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};
```

### Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - run: npm ci
      - run: npm run build

      - name: Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: npx semantic-release
```

## Versioning Strategy

### Semantic Versioning (SemVer)

```
MAJOR.MINOR.PATCH

1.0.0 → 1.0.1  (patch - bug fix)
1.0.1 → 1.1.0  (minor - new feature)
1.1.0 → 2.0.0  (major - breaking change)
```

### Conventional Commits

```
feat: add new feature (minor bump)
fix: fix bug (patch bump)
perf: performance improvement (patch bump)
docs: update docs (no bump)
chore: maintenance (no bump)

feat!: breaking change (major bump)
fix!: breaking bug fix (major bump)
```

## Changelog Generation

```markdown
# Changelog

## [2.1.0] - 2024-01-15

### Added

- New dashboard widget (#123)
- Export to PDF feature (#125)

### Fixed

- Memory leak in data processing (#124)
- Typo in error message (#126)

### Changed

- Updated dependencies

## [2.0.0] - 2024-01-01

### Breaking Changes

- Removed deprecated API endpoints
- Changed authentication method

### Migration Guide

See MIGRATION.md for upgrade instructions
```

## Docker Image Publishing

```yaml
docker-release:
  runs-on: ubuntu-latest
  needs: test
  if: github.ref == 'refs/heads/main'
  steps:
    - uses: actions/checkout@v4

    - name: Get version
      id: version
      run: echo "version=$(cat package.json | jq -r '.version')" >> $GITHUB_OUTPUT

    - name: Login to Docker Hub
      uses: docker/login-action@v3
      with:
        username: ${{ secrets.DOCKER_USERNAME }}
        password: ${{ secrets.DOCKER_PASSWORD }}

    - name: Build and push
      uses: docker/build-push-action@v5
      with:
        context: .
        push: true
        tags: |
          mycompany/myapp:latest
          mycompany/myapp:${{ steps.version.outputs.version }}
```

## NPM Publishing

```yaml
publish:
  runs-on: ubuntu-latest
  needs: test
  if: github.event_name == 'release'
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: "20"
        registry-url: "https://registry.npmjs.org"

    - run: npm ci
    - run: npm run build

    - name: Publish to npm
      run: npm publish
      env:
        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## GitHub Release Notes

````yaml
- name: Create GitHub Release
  uses: actions/create-release@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    tag_name: v${{ steps.version.outputs.version }}
    release_name: Release ${{ steps.version.outputs.version }}
    body: |
      ## What's Changed
      ${{ steps.changelog.outputs.content }}

      ## Installation
      ```bash
      npm install mypackage@${{ steps.version.outputs.version }}
      ```
    draft: false
    prerelease: false
````

## Best Practices

1. **Conventional commits**: Standardize commit format
2. **Protected branches**: Prevent direct pushes to main
3. **Automated versioning**: Let tools determine versions
4. **Changelogs**: Auto-generate from commits
5. **Git tags**: Tag every release
6. **Release notes**: Include migration guides
7. **Dry run**: Test releases in staging

## Output Checklist

- [ ] Changesets or semantic-release configured
- [ ] Versioning strategy documented
- [ ] Changelog generation automated
- [ ] Git tagging automated
- [ ] Release notes template
- [ ] NPM publishing (if package)
- [ ] Docker publishing (if applicable)
- [ ] Protected branch rules
