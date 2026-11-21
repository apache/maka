---
name: project-scaffolder
description: Generates complete starter repositories for various tech stacks (Next.js, Vite, Nest, FastAPI, etc.) with best-practice conventions, folder structure, baseline code, configs, scripts, and setup documentation. Use when users request to "scaffold a project", "create a starter repo", "initialize a new project", or specify a tech stack to begin with.
---

# Project Scaffolder

Generate production-ready starter repositories with best-practice conventions for any tech stack.

## Core Workflow

1. **Determine stack**: Ask user to specify or infer from context (Next.js, Vite, Nest, FastAPI, etc.)
2. **Select template**: Use references/templates.md to choose the appropriate project structure
3. **Generate structure**: Create complete folder tree with all necessary files
4. **Add baseline code**: Include working "hello world" route/page as proof of concept
5. **Configure tooling**: Add package.json/requirements.txt, tsconfig, linting, formatting configs
6. **Create scripts**: Include dev, build, test, and deployment scripts
7. **Document setup**: Generate comprehensive README with setup steps and next actions

## Key Deliverables

Every scaffolded project must include:

- **Folder tree**: Well-organized src/, lib/, config/, tests/ structure
- **Baseline code**: Working hello world endpoint or page
- **Package files**: package.json, requirements.txt, Cargo.toml, etc.
- **Configs**: TypeScript, ESLint, Prettier, environment files (.env.example)
- **Scripts**: npm scripts or Makefile for common tasks
- **README**: Setup instructions, tech stack overview, next steps
- **Git setup**: .gitignore configured for the stack

## Stack-Specific Patterns

See `references/templates.md` for detailed patterns per stack:

- Next.js App Router
- Vite + React
- NestJS
- FastAPI
- Express + TypeScript
- Vue + Vite
- SvelteKit

## Best Practices

- Use absolute imports (@/ alias) where supported
- Include environment variable templates
- Add basic error handling and logging setup
- Configure path mappings in tsconfig
- Include Docker files for containerization (optional)
- Add GitHub Actions or CI workflow templates (optional)

## Progressive Enhancement

Start with minimal viable structure, then add:

- Database setup (Prisma, TypeORM, SQLAlchemy)
- Auth scaffolding (NextAuth, Passport, JWT)
- API client setup (Axios, Fetch wrapper)
- State management (Zustand, Redux, Pinia)
- Testing setup (Jest, Vitest, Pytest)

## Output Structure

Present the complete project tree first, then create all files in proper locations. Always provide a summary of what was created and next steps to run the project.
