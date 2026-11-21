---
name: docs-starter-kit
description: Generates comprehensive documentation templates for open-source and internal projects including README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, LICENSE, and other standard docs with suggested sections and best practices. Use when users request "create project docs", "add OSS documentation", "setup standard docs", or "make it open-source ready".
---

# Docs Starter Kit

Generate complete, professional documentation for any project.

## Core Workflow

1. **Determine project type**: OSS public, internal, library, application
2. **Select templates**: Choose appropriate docs based on project type
3. **Customize content**: Fill in project-specific information
4. **Add sections**: Include relevant sections for the project
5. **Review completeness**: Ensure all essential docs are present
6. **Format consistently**: Apply consistent style and structure

## Essential Documentation Files

### README.md (Required)

Project overview and getting started guide

- Project description and purpose
- Features and capabilities
- Quick start guide
- Installation instructions
- Usage examples
- Configuration options
- Contributing link
- License information

### CONTRIBUTING.md (Recommended)

Guide for contributors

- How to contribute
- Development setup
- Code style guidelines
- Testing requirements
- Pull request process
- Code of conduct link

### LICENSE (Required for OSS)

Project license

- MIT, Apache 2.0, GPL, BSD, etc.
- Copyright holder and year

### CODE_OF_CONDUCT.md (OSS Best Practice)

Community guidelines

- Expected behavior
- Unacceptable behavior
- Enforcement procedures
- Contact information

### SECURITY.md (Recommended)

Security policy and reporting

- Supported versions
- Reporting vulnerabilities
- Response timeline
- Security update process

### CHANGELOG.md (Recommended)

Version history

- Notable changes per version
- Breaking changes highlighted
- Release dates
- Following Keep a Changelog format

## README.md Template

````markdown
# Project Name

Brief description of what this project does and who it's for.

## Features

- ✨ Feature 1
- 🚀 Feature 2
- 🎯 Feature 3

## Quick Start

```bash
# Clone the repository
git clone https://github.com/username/project-name.git

# Install dependencies
npm install

# Run development server
npm run dev
```
````

## Installation

### Prerequisites

- Node.js 20+
- npm or pnpm
- PostgreSQL 15+ (if applicable)

### Setup

1. Clone and install:

   ```bash
   git clone <repo>
   npm install
   ```

2. Configure environment:

   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

3. Setup database (if applicable):

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

4. Start development:
   ```bash
   npm run dev
   ```

## Usage

### Basic Example

```typescript
import { something } from "project-name";

const result = something();
```

### Advanced Usage

[More detailed examples]

## Configuration

Available environment variables:

| Variable       | Description            | Default |
| -------------- | ---------------------- | ------- |
| `API_KEY`      | API authentication key | -       |
| `PORT`         | Server port            | 3000    |
| `DATABASE_URL` | Database connection    | -       |

## Documentation

- [API Reference](./docs/API.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Contributing Guide](./CONTRIBUTING.md)

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test path/to/test
```

## Deployment

[Deployment instructions]

## Built With

- [Next.js](https://nextjs.org/) - React framework
- [Prisma](https://prisma.io/) - Database ORM
- [Tailwind CSS](https://tailwindcss.com/) - Styling

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Authors

- **Your Name** - _Initial work_ - [YourGitHub](https://github.com/yourusername)

## Acknowledgments

- Hat tip to anyone whose code was used
- Inspiration
- References

````

## CONTRIBUTING.md Template

```markdown
# Contributing to [Project Name]

Thank you for your interest in contributing! This document provides guidelines for contributing to this project.

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, include:

- Clear and descriptive title
- Detailed description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, etc.)
- Screenshots if applicable

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, include:

- Clear and descriptive title
- Detailed description of the proposed feature
- Explanation of why this enhancement would be useful
- Possible implementation approach

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass (`npm test`)
6. Commit using conventional commits (`git commit -m 'feat: add amazing feature'`)
7. Push to your fork (`git push origin feature/amazing-feature`)
8. Open a Pull Request

## Development Setup

See [README.md](README.md) for initial setup instructions.

### Development Workflow

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests in watch mode
npm run test:watch

# Run linter
npm run lint

# Format code
npm run format
````

## Code Style

- Follow existing code style
- Use TypeScript for all new code
- Run `npm run lint` and `npm run format` before committing
- Write meaningful commit messages following Conventional Commits

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

## Testing

- Write tests for all new features
- Maintain test coverage above 80%
- Run tests before submitting PR
- Include both unit and integration tests where appropriate

## Documentation

- Update README.md if adding features
- Document new environment variables
- Add JSDoc comments for public APIs
- Update CHANGELOG.md for notable changes

## Review Process

1. Automated checks must pass (tests, linting, build)
2. At least one maintainer approval required
3. Address all review comments
4. Maintainer will merge when approved

## Questions?

Feel free to open an issue with your question or contact [maintainer@email.com](mailto:maintainer@email.com).

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.

````

## SECURITY.md Template

```markdown
# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x.x   | :white_check_mark: |
| 1.x.x   | :x:                |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please follow these steps:

### Do Not

- Open a public GitHub issue
- Disclose the vulnerability publicly before we've addressed it

### Do

1. **Email us** at security@projectname.com
2. **Include details:**
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 1 week
- **Regular updates:** Every 2 weeks
- **Resolution:** Depends on severity and complexity

### Disclosure Policy

- We will investigate and respond promptly
- We will work with you to understand the issue
- We will keep you informed of our progress
- We will credit you for the discovery (unless you prefer to remain anonymous)

### Security Update Process

1. Patch is developed and tested
2. Security advisory is prepared
3. New version is released
4. Advisory is published
5. Users are notified

## Best Practices

When using this project:

- Keep dependencies up to date
- Use environment variables for secrets
- Enable security features in production
- Follow principle of least privilege
- Regularly review access logs

## Known Security Considerations

[Document any known security considerations or limitations]

## Security-Related Configuration

[Document security-related configuration options]
````

## CODE_OF_CONDUCT.md Template

```markdown
# Code of Conduct

## Our Pledge

We pledge to make participation in our project a harassment-free experience for everyone, regardless of age, body size, disability, ethnicity, gender identity and expression, level of experience, nationality, personal appearance, race, religion, or sexual identity and orientation.

## Our Standards

### Positive Behavior

- Using welcoming and inclusive language
- Being respectful of differing viewpoints and experiences
- Gracefully accepting constructive criticism
- Focusing on what is best for the community
- Showing empathy towards other community members

### Unacceptable Behavior

- Trolling, insulting/derogatory comments, and personal attacks
- Public or private harassment
- Publishing others' private information without permission
- Other conduct which could reasonably be considered inappropriate

## Our Responsibilities

Project maintainers are responsible for clarifying standards of acceptable behavior and will take appropriate and fair corrective action in response to unacceptable behavior.

## Scope

This Code of Conduct applies within all project spaces and when representing the project or its community.

## Enforcement

Instances of abusive, harassing, or otherwise unacceptable behavior may be reported to the project team at [conduct@projectname.com]. All complaints will be reviewed and investigated promptly and fairly.

## Attribution

This Code of Conduct is adapted from the [Contributor Covenant](https://www.contributor-covenant.org), version 2.0.
```

## LICENSE Templates

### MIT License

```
MIT License

Copyright (c) [year] [fullname]

Permission is hereby granted, free of charge, to any person obtaining a copy...
```

### Apache 2.0

```
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/
```

## CHANGELOG.md Template

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- New feature X

### Changed

- Updated dependency Y

### Fixed

- Bug Z

## [1.0.0] - 2024-01-15

### Added

- Initial release
- Feature A
- Feature B

### Security

- Fixed vulnerability in dependency

[unreleased]: https://github.com/user/project/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/user/project/releases/tag/v1.0.0
```

## Additional Documentation

### API.md

API reference documentation

### ARCHITECTURE.md

System design and architecture

### DEPLOYMENT.md

Deployment instructions

### DEVELOPMENT.md

Development environment setup

### FAQ.md

Frequently asked questions

### TROUBLESHOOTING.md

Common issues and solutions

## Documentation Best Practices

1. **Keep it updated**: Review docs with each release
2. **Be concise**: Clear and to the point
3. **Use examples**: Show, don't just tell
4. **Link related docs**: Cross-reference appropriately
5. **Consider audience**: Write for your users' level
6. **Use consistent formatting**: Follow style guides
7. **Include visuals**: Diagrams, screenshots, examples

## Project Type Variations

### Library/Package

Focus on: API reference, usage examples, installation

### Application

Focus on: Setup, configuration, deployment

### CLI Tool

Focus on: Commands, options, examples

### Internal Tool

Focus on: Access, authentication, company-specific processes

## Checklist

For complete project documentation:

- [ ] README.md with clear description and quick start
- [ ] CONTRIBUTING.md with development guidelines
- [ ] LICENSE file (if open source)
- [ ] CODE_OF_CONDUCT.md (if open source)
- [ ] SECURITY.md with vulnerability reporting
- [ ] CHANGELOG.md for version history
- [ ] .github/ISSUE_TEMPLATE/ for bug reports and features
- [ ] .github/PULL_REQUEST_TEMPLATE.md
- [ ] docs/ folder for additional documentation
- [ ] API reference (if library)
- [ ] Architecture documentation (if complex)
