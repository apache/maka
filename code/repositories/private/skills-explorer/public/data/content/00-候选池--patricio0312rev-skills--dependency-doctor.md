---
name: dependency-doctor
description: Audits project dependencies for outdated packages, duplicates, heavy/problematic libraries, security vulnerabilities, and risky version combinations. Generates prioritized reports with security, performance, and maintainability insights, upgrade paths, and safe pinning recommendations. Use when users request dependency audits, package updates, security checks, or dependency optimization.
---

# Dependency Doctor

Comprehensive dependency health analysis and upgrade planning.

## Core Workflow

1. **Scan manifests**: Analyze package.json, requirements.txt, Cargo.toml, go.mod, etc.
2. **Check versions**: Identify outdated packages against latest stable versions
3. **Detect issues**: Find duplicates, security vulnerabilities, deprecated packages, heavy bundles
4. **Assess risk**: Evaluate breaking changes and version compatibility
5. **Prioritize**: Rank issues by severity (security > performance > maintenance)
6. **Generate upgrade path**: Create safe, incremental update plan
7. **Recommend pins**: Suggest version constraints to avoid future issues

## Analysis Categories

### Security Issues (Critical)

- Known CVEs in dependencies
- Unmaintained packages (no updates >2 years)
- Packages with security advisories
- Transitive dependency vulnerabilities

### Outdated Packages (High)

- Major versions behind (breaking changes)
- Minor versions behind (new features)
- Patch versions behind (bug fixes)

### Duplicate Dependencies (Medium)

- Multiple versions of same package
- Overlapping functionality (lodash + underscore)
- Can be deduplicated

### Heavy Dependencies (Medium)

- Large bundle sizes (>500KB)
- Unnecessary peer dependencies
- Better alternatives available

### Risky Combinations (Medium)

- Known incompatible version pairs
- Conflicting peer dependencies
- Framework version mismatches

## Report Structure

````markdown
# Dependency Audit Report

## 🔴 Critical Security Issues (2)

- axios@0.21.0 → CVE-2021-3749 → Upgrade to 1.6.0+
- lodash@4.17.15 → Prototype pollution → Upgrade to 4.17.21+

## 🟡 High Priority Updates (5)

- react@17.0.2 → 18.2.0 (major, breaking changes)
- next@12.0.0 → 14.1.0 (major, new features)

## 🟢 Maintenance Updates (8)

- typescript@4.9.0 → 5.3.3 (patch improvements)

## 📦 Duplicates Found (3)

- moment: 2.29.1, 2.30.0 → Deduplicate to 2.30.0
- @types/node: 18.0.0, 20.0.0 → Align to 20.0.0

## 🏋️ Heavy Dependencies (2)

- moment (232KB) → Consider date-fns (12KB)
- lodash (full) → Consider lodash-es or specific imports

## Upgrade Path

### Phase 1: Security (Do First)

```bash
npm update axios lodash
npm audit fix
```
````

### Phase 2: Major Frameworks (Test Thoroughly)

```bash
npm install react@18 react-dom@18
npm install next@14
# Run full test suite
```

### Phase 3: Minor Updates (Low Risk)

```bash
npm update
```

## Safe Pin Recommendations

```json
{
  "axios": "^1.6.0",
  "react": "^18.2.0",
  "typescript": "~5.3.0"
}
```

```

## Package Manager Commands

### npm
- Audit: `npm audit`
- Outdated: `npm outdated`
- Dedupe: `npm dedupe`
- Update: `npm update [package]`

### yarn
- Audit: `yarn audit`
- Outdated: `yarn outdated`
- Dedupe: `yarn dedupe`
- Upgrade: `yarn upgrade [package]`

### pnpm
- Audit: `pnpm audit`
- Outdated: `pnpm outdated`
- Dedupe: `pnpm dedupe`
- Update: `pnpm update [package]`

### pip
- Outdated: `pip list --outdated`
- Update: `pip install --upgrade [package]`
- Security: `pip-audit` or `safety check`

## Upgrade Best Practices

1. **Backup first**: Commit current state or create branch
2. **Read changelogs**: Check for breaking changes
3. **Update incrementally**: One major version at a time
4. **Test thoroughly**: Run full test suite after each update
5. **Check peer deps**: Ensure compatibility
6. **Lock files**: Commit updated lock files
7. **Monitor**: Watch for runtime issues after deployment

## Version Pinning Strategy

- **Exact**: `1.2.3` - Only for problematic packages
- **Patch**: `~1.2.3` - Safe updates (1.2.x)
- **Minor**: `^1.2.3` - Most common (1.x.x)
- **Range**: `>=1.2.3 <2.0.0` - Explicit bounds

## References

See `references/common-issues.md` for known problematic package combinations and migration guides.
```
