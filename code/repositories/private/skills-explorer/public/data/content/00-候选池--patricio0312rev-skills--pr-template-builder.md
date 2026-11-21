---
name: pr-template-builder
description: Creates GitHub pull request templates, issue templates, and discussion templates with proper YAML configuration. Use when users request "PR template", "issue template", "GitHub templates", "pull request template", or "contribution guidelines".
---

# PR Template Builder

Create standardized GitHub templates for pull requests, issues, and discussions to streamline collaboration.

## Core Workflow

1. **Identify template needs**: PR, issues, discussions
2. **Create .github directory**: Standard location for templates
3. **Design PR template**: Checklist, sections, guidance
4. **Create issue templates**: Bug reports, feature requests
5. **Add config.yml**: Control issue/PR creation flow
6. **Test templates**: Verify rendering on GitHub

## Directory Structure

```
.github/
├── PULL_REQUEST_TEMPLATE.md          # Default PR template
├── PULL_REQUEST_TEMPLATE/            # Multiple PR templates
│   ├── feature.md
│   ├── bugfix.md
│   └── hotfix.md
├── ISSUE_TEMPLATE/
│   ├── config.yml                    # Issue template config
│   ├── bug_report.yml                # Bug report form
│   ├── feature_request.yml           # Feature request form
│   └── question.yml                  # Question form
├── DISCUSSION_TEMPLATE/
│   ├── announcements.yml
│   └── ideas.yml
├── CONTRIBUTING.md                   # Contribution guidelines
├── CODE_OF_CONDUCT.md               # Community standards
└── CODEOWNERS                       # Auto-assign reviewers
```

## Pull Request Templates

### Standard PR Template

```markdown
<!-- .github/PULL_REQUEST_TEMPLATE.md -->

## Summary

<!-- Describe your changes in 1-2 sentences -->

## Related Issue

<!-- Link to the issue this PR addresses -->

Fixes #

## Type of Change

<!-- Mark the appropriate option -->

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature causing existing functionality to change)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] Performance improvement
- [ ] Test updates

## Changes Made

<!-- List the specific changes made in this PR -->

-
-
-

## Screenshots

<!-- If applicable, add screenshots or GIFs demonstrating the changes -->

## Testing

<!-- Describe how you tested these changes -->

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

### Test Instructions

<!-- Steps for reviewers to test -->

1.
2.
3.

## Checklist

<!-- Ensure all items are checked before requesting review -->

- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have commented my code where necessary
- [ ] I have updated the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests proving my fix/feature works
- [ ] All new and existing tests pass
- [ ] Any dependent changes have been merged

## Additional Notes

<!-- Any additional information reviewers should know -->
```

### Feature PR Template

```markdown
<!-- .github/PULL_REQUEST_TEMPLATE/feature.md -->

## Feature: [Feature Name]

### Summary

<!-- Brief description of the feature -->

### Motivation

<!-- Why is this feature needed? What problem does it solve? -->

### Implementation Details

<!-- Technical approach and key decisions -->

### User Impact

<!-- How will users interact with this feature? -->

### API Changes

<!-- List any API changes (if applicable) -->

| Endpoint | Method | Change |
| -------- | ------ | ------ |
|          |        |        |

### Database Changes

<!-- List any schema changes (if applicable) -->

- [ ] Migration added
- [ ] Migration tested on staging data

### Feature Flag

<!-- Is this behind a feature flag? -->

- [ ] Feature flag: `FEATURE_NAME`
- [ ] No feature flag needed

### Testing

- [ ] Unit tests added
- [ ] Integration tests added
- [ ] E2E tests added
- [ ] Manual testing completed

### Documentation

- [ ] README updated
- [ ] API docs updated
- [ ] Changelog entry added

### Rollback Plan

<!-- How can this be rolled back if issues arise? -->

### Checklist

- [ ] Code review requested
- [ ] CI/CD pipeline passes
- [ ] Performance impact assessed
- [ ] Security review (if needed)
- [ ] Accessibility requirements met
```

### Bugfix PR Template

```markdown
<!-- .github/PULL_REQUEST_TEMPLATE/bugfix.md -->

## Bug Fix: [Brief Description]

### Issue

Fixes #

### Root Cause

<!-- What caused this bug? -->

### Solution

<!-- How does this PR fix the issue? -->

### Regression Risk

<!-- What could this change break? -->

- Risk level: Low / Medium / High
- Areas affected:

### Testing

#### Reproduction Steps (Before Fix)

1.
2.
3.

#### Verification Steps (After Fix)

1.
2.
3.

### Test Coverage

- [ ] Unit test added to prevent regression
- [ ] Integration test added
- [ ] Manual verification completed

### Checklist

- [ ] Root cause identified
- [ ] Fix verified locally
- [ ] No new warnings introduced
- [ ] Tests added for regression prevention
- [ ] Related issues linked
```

## Issue Templates

### Bug Report (YAML Form)

```yaml
# .github/ISSUE_TEMPLATE/bug_report.yml
name: Bug Report
description: Report a bug or unexpected behavior
title: "[Bug]: "
labels: ["bug", "triage"]
assignees: []

body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to report this bug!
        Please fill out the form below to help us investigate.

  - type: textarea
    id: description
    attributes:
      label: Bug Description
      description: A clear and concise description of the bug
      placeholder: What happened?
    validations:
      required: true

  - type: textarea
    id: reproduction
    attributes:
      label: Steps to Reproduce
      description: Steps to reproduce the behavior
      placeholder: |
        1. Go to '...'
        2. Click on '...'
        3. Scroll down to '...'
        4. See error
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: Expected Behavior
      description: What did you expect to happen?
    validations:
      required: true

  - type: textarea
    id: actual
    attributes:
      label: Actual Behavior
      description: What actually happened?
    validations:
      required: true

  - type: textarea
    id: screenshots
    attributes:
      label: Screenshots
      description: If applicable, add screenshots to help explain the problem
    validations:
      required: false

  - type: dropdown
    id: environment
    attributes:
      label: Environment
      description: Where are you experiencing this bug?
      options:
        - Production
        - Staging
        - Development
        - Local
    validations:
      required: true

  - type: dropdown
    id: browser
    attributes:
      label: Browser
      description: What browser are you using?
      multiple: true
      options:
        - Chrome
        - Firefox
        - Safari
        - Edge
        - Other
    validations:
      required: false

  - type: input
    id: version
    attributes:
      label: App Version
      description: What version of the app are you using?
      placeholder: e.g., 1.2.3
    validations:
      required: false

  - type: textarea
    id: logs
    attributes:
      label: Relevant Logs
      description: Please copy and paste any relevant log output
      render: shell
    validations:
      required: false

  - type: checkboxes
    id: terms
    attributes:
      label: Checklist
      options:
        - label: I have searched for existing issues
          required: true
        - label: I have provided all requested information
          required: true
```

### Feature Request (YAML Form)

```yaml
# .github/ISSUE_TEMPLATE/feature_request.yml
name: Feature Request
description: Suggest a new feature or improvement
title: "[Feature]: "
labels: ["enhancement", "triage"]
assignees: []

body:
  - type: markdown
    attributes:
      value: |
        Thanks for suggesting a new feature!
        Please describe your idea in detail.

  - type: textarea
    id: problem
    attributes:
      label: Problem Statement
      description: What problem would this feature solve?
      placeholder: I'm always frustrated when...
    validations:
      required: true

  - type: textarea
    id: solution
    attributes:
      label: Proposed Solution
      description: Describe the solution you'd like
    validations:
      required: true

  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives Considered
      description: Describe any alternative solutions you've considered
    validations:
      required: false

  - type: dropdown
    id: priority
    attributes:
      label: Priority
      description: How important is this feature to you?
      options:
        - Nice to have
        - Important
        - Critical - blocking my work
    validations:
      required: true

  - type: textarea
    id: context
    attributes:
      label: Additional Context
      description: Add any other context, mockups, or screenshots
    validations:
      required: false

  - type: checkboxes
    id: contribution
    attributes:
      label: Contribution
      options:
        - label: I would be willing to help implement this feature
          required: false
```

### Issue Template Config

```yaml
# .github/ISSUE_TEMPLATE/config.yml
blank_issues_enabled: false
contact_links:
  - name: Documentation
    url: https://docs.example.com
    about: Check our documentation for answers
  - name: Discord Community
    url: https://discord.gg/example
    about: Ask questions and get help from the community
  - name: Stack Overflow
    url: https://stackoverflow.com/questions/tagged/example
    about: Search for existing answers
```

## Discussion Templates

```yaml
# .github/DISCUSSION_TEMPLATE/ideas.yml
title: "[Idea]: "
labels:
  - idea
body:
  - type: markdown
    attributes:
      value: |
        Share your ideas for improving the project!

  - type: textarea
    id: idea
    attributes:
      label: Your Idea
      description: Describe your idea in detail
    validations:
      required: true

  - type: textarea
    id: benefits
    attributes:
      label: Benefits
      description: What benefits would this bring?
    validations:
      required: true

  - type: textarea
    id: drawbacks
    attributes:
      label: Potential Drawbacks
      description: Any potential downsides?
    validations:
      required: false
```

## CODEOWNERS

```
# .github/CODEOWNERS
# Default owners for everything
* @org/core-team

# Frontend ownership
/src/components/ @org/frontend-team
/src/pages/ @org/frontend-team
*.tsx @org/frontend-team
*.css @org/frontend-team

# Backend ownership
/src/api/ @org/backend-team
/src/services/ @org/backend-team
/prisma/ @org/backend-team

# DevOps ownership
/.github/ @org/devops-team
/docker/ @org/devops-team
Dockerfile @org/devops-team
*.yml @org/devops-team

# Documentation
/docs/ @org/docs-team
*.md @org/docs-team

# Security-sensitive files
/src/auth/ @org/security-team @org/backend-team
*.pem @org/security-team
```

## CONTRIBUTING.md

```markdown
<!-- .github/CONTRIBUTING.md -->

# Contributing to [Project Name]

Thank you for your interest in contributing! This document provides guidelines
and steps for contributing.

## Code of Conduct

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](../../issues)
2. If not, create a new issue using the Bug Report template
3. Provide as much detail as possible

### Suggesting Features

1. Check if the feature has been suggested in [Issues](../../issues)
2. Create a new issue using the Feature Request template
3. Explain the use case and benefits

### Submitting Changes

#### First Time Contributors

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/REPO_NAME`
3. Add upstream remote: `git remote add upstream https://github.com/ORG/REPO_NAME`
4. Create a branch: `git checkout -b feature/your-feature-name`

#### Development Workflow

1. Sync with upstream: `git fetch upstream && git rebase upstream/main`
2. Make your changes
3. Run tests: `npm test`
4. Run linting: `npm run lint`
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
```

feat(scope): add new feature
fix(scope): fix bug description
docs(scope): update documentation

````
6. Push to your fork: `git push origin feature/your-feature-name`
7. Create a Pull Request

### Pull Request Guidelines

- Fill out the PR template completely
- Link related issues
- Include tests for new functionality
- Update documentation as needed
- Ensure CI passes
- Request review from appropriate team members

## Development Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests
npm test

# Run linting
npm run lint
````

## Style Guide

### Code Style

- Use TypeScript for all new code
- Follow the existing code style
- Use meaningful variable and function names
- Add comments for complex logic

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `style:` formatting
- `refactor:` code restructuring
- `test:` adding tests
- `chore:` maintenance

### Branch Naming

- `feature/` - new features
- `fix/` - bug fixes
- `docs/` - documentation
- `refactor/` - code refactoring

## Getting Help

- Join our [Discord](https://discord.gg/example)
- Check the [Documentation](https://docs.example.com)
- Ask in [Discussions](../../discussions)

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](../LICENSE).

````

## Workflow Automation

### Auto-label PRs

```yaml
# .github/workflows/labeler.yml
name: PR Labeler

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/labeler@v5
        with:
          repo-token: "${{ secrets.GITHUB_TOKEN }}"
````

```yaml
# .github/labeler.yml
frontend:
  - changed-files:
      - any-glob-to-any-file:
          - "src/components/**"
          - "src/pages/**"
          - "**/*.tsx"
          - "**/*.css"

backend:
  - changed-files:
      - any-glob-to-any-file:
          - "src/api/**"
          - "src/services/**"

documentation:
  - changed-files:
      - any-glob-to-any-file:
          - "**/*.md"
          - "docs/**"

tests:
  - changed-files:
      - any-glob-to-any-file:
          - "**/*.test.ts"
          - "**/*.spec.ts"
          - "__tests__/**"
```

### PR Size Labels

```yaml
# .github/workflows/pr-size.yml
name: PR Size

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  size:
    runs-on: ubuntu-latest
    steps:
      - uses: codelytv/pr-size-labeler@v1
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          xs_label: "size/XS"
          xs_max_size: 10
          s_label: "size/S"
          s_max_size: 100
          m_label: "size/M"
          m_max_size: 500
          l_label: "size/L"
          l_max_size: 1000
          xl_label: "size/XL"
          fail_if_xl: false
```

## Best Practices

1. **Keep templates focused**: One purpose per template
2. **Use YAML forms**: Better UX than markdown for issues
3. **Add helpful descriptions**: Guide users through fields
4. **Make fields required strategically**: Balance info vs friction
5. **Include checklists**: Ensure completeness
6. **Link to documentation**: Help users find answers
7. **Disable blank issues**: Force template usage
8. **Add CODEOWNERS**: Automate review assignment
9. **Test on GitHub**: Verify rendering and validation

## Output Checklist

Every template setup should include:

- [ ] .github/ directory created
- [ ] PULL_REQUEST_TEMPLATE.md with checklist
- [ ] Bug report issue template (YAML form)
- [ ] Feature request issue template (YAML form)
- [ ] Issue template config.yml
- [ ] CODEOWNERS file for auto-assignment
- [ ] CONTRIBUTING.md guidelines
- [ ] Labels defined for categorization
- [ ] Workflow for auto-labeling PRs
- [ ] Templates tested on GitHub
