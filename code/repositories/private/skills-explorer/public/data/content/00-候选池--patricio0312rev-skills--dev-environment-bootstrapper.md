---
name: dev-environment-bootstrapper
description: Standardizes development environment setup across machines by generating tool version configs (Node, Python, Ruby), package manager configs (pnpm, Volta, asdf, mise), environment variable templates, and setup scripts with onboarding documentation. Use when users need to "setup dev environment", "standardize tooling", "configure version managers", or "create onboarding scripts".
---

# Dev Environment Bootstrapper

Create consistent, reproducible development environments across all machines.

## Core Workflow

1. **Detect stack**: Identify languages and tools used in project
2. **Choose version manager**: Select appropriate tool (Volta, asdf, mise, nvm, pyenv)
3. **Generate configs**: Create .tool-versions, .nvmrc, package.json volta fields, etc.
4. **Setup environment vars**: Create .env.example with all required variables
5. **Write setup script**: Generate bootstrap script for automated setup
6. **Create onboarding doc**: Write SETUP.md with step-by-step instructions

## Version Management Strategies

### Volta (Recommended for Node.js)

```json
// package.json
{
  "volta": {
    "node": "20.11.0",
    "pnpm": "8.15.0"
  }
}
```

### asdf (Multi-language)

```
# .tool-versions
nodejs 20.11.0
python 3.11.7
ruby 3.2.2
```

### mise (Modern alternative to asdf)

```toml
# .mise.toml
[tools]
node = "20.11.0"
python = "3.11"
```

### nvm (Node.js only)

```
# .nvmrc
20.11.0
```

## Environment Variables Template

```bash
# .env.example

# Application
NODE_ENV=development
PORT=3000

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# External APIs
OPENAI_API_KEY=sk-...
STRIPE_SECRET_KEY=sk_test_...

# Feature Flags
ENABLE_FEATURE_X=false
```

## Setup Script Structure

### For Node.js Projects

```bash
#!/bin/bash
set -e

echo "🚀 Setting up development environment..."

# Check prerequisites
command -v pnpm >/dev/null 2>&1 || { echo "Installing pnpm..."; npm install -g pnpm; }

# Install dependencies
echo "📦 Installing dependencies..."
pnpm install

# Setup environment
echo "⚙️ Setting up environment variables..."
cp .env.example .env
echo "Edit .env file with your values"

# Setup database (if needed)
if [ -f "prisma/schema.prisma" ]; then
  echo "🗄️ Setting up database..."
  pnpm prisma generate
  pnpm prisma migrate dev
fi

echo "✅ Setup complete! Run 'pnpm dev' to start"
```

### For Python Projects

```bash
#!/bin/bash
set -e

echo "🚀 Setting up development environment..."

# Create virtual environment
python -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
pip install -r requirements-dev.txt

# Setup environment
cp .env.example .env

# Run migrations
python manage.py migrate

echo "✅ Setup complete! Run 'source venv/bin/activate && python manage.py runserver'"
```

## Onboarding Documentation Template

````markdown
# Development Setup

## Prerequisites

- Node.js 20.11+ (managed via Volta)
- pnpm 8.15+
- PostgreSQL 15+
- Redis 7+ (optional)

## Quick Start

1. **Clone repository**
   ```bash
   git clone <repo-url>
   cd <repo-name>
   ```
````

2. **Install tools** (if using Volta)

   ```bash
   curl https://get.volta.sh | bash
   # Volta will automatically use versions from package.json
   ```

3. **Run setup script**

   ```bash
   ./scripts/setup.sh
   ```

4. **Configure environment**

   - Copy `.env.example` to `.env`
   - Fill in required values
   - See ENVIRONMENT_VARIABLES.md for details

5. **Start development server**
   ```bash
   pnpm dev
   ```

## Troubleshooting

**Port already in use**

- Kill process: `lsof -ti:3000 | xargs kill`

**Database connection failed**

- Check PostgreSQL is running: `pg_isready`
- Verify DATABASE_URL in .env

**Node version mismatch**

- Install Volta: See step 2
- Or use nvm: `nvm use`

## Common Commands

```bash
pnpm dev          # Start dev server
pnpm build        # Build for production
pnpm test         # Run tests
pnpm lint         # Check code quality
pnpm format       # Format code
```

```

## Cross-Platform Considerations

### Shell Scripts
- Provide both .sh (Unix) and .ps1 (Windows) versions
- Or use Node.js scripts for true cross-platform

### Path Separators
- Use Node's `path.join()` in scripts
- Avoid hardcoded `/` or `\`

### Line Endings
- Configure .gitattributes:
```

- text=auto
  \*.sh text eol=lf

```

## Version Manager Comparison

| Tool | Languages | Auto-switching | Config File |
|------|-----------|----------------|-------------|
| Volta | Node, Yarn, pnpm | Yes | package.json |
| asdf | Multi | Yes | .tool-versions |
| mise | Multi | Yes | .mise.toml |
| nvm | Node only | Manual | .nvmrc |
| pyenv | Python only | Yes | .python-version |

## Best Practices

1. **Pin exact versions** in configs to avoid surprises
2. **Document all requirements** in onboarding guide
3. **Test setup script** on clean machine
4. **Keep .env.example updated** with all variables
5. **Provide troubleshooting** for common issues
6. **Use tool version managers** over manual installs
7. **Make setup idempotent** (safe to run multiple times)

## Output Checklist

Every dev environment bootstrap should include:

- [ ] Version manager config (.tool-versions, package.json volta, etc.)
- [ ] Package manager choice documented
- [ ] .env.example with all variables
- [ ] Setup script (setup.sh or setup.js)
- [ ] SETUP.md or DEVELOPMENT.md onboarding guide
- [ ] Troubleshooting section
- [ ] Common commands reference
- [ ] Prerequisites listed
```
