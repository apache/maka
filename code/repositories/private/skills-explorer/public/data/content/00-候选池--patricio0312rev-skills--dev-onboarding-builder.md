---
name: dev-onboarding-builder
description: Creates comprehensive developer onboarding documentation and materials including step-by-step setup guides, first-task assignments, expected time per step, common troubleshooting, team introductions, and code walkthrough tours. Use when preparing "new developer onboarding", "first day setup", "junior dev training", or "team member onboarding".
---

# Developer Onboarding Builder

Create frictionless first-day experiences for new team members.

## Core Workflow

1. **Assess prerequisites**: Identify required tools and access
2. **Create setup guide**: Step-by-step environment configuration
3. **Design first task**: Choose appropriate starter assignment
4. **Add time estimates**: Set expectations for each step
5. **Document common issues**: Preemptive troubleshooting
6. **Introduce team**: Context on people and structure
7. **Provide codebase tour**: Walkthrough of key areas

## Onboarding Documentation Structure

### ONBOARDING.md Template

````markdown
# Welcome to [Team/Project Name]! 🎉

This guide will help you get set up and productive on your first day.

**Estimated completion time:** 2-3 hours

## Before You Start

### Access Checklist

- [ ] GitHub organization access
- [ ] Slack workspace invitation
- [ ] Email account setup
- [ ] VPN credentials (if remote)
- [ ] Cloud console access (AWS/GCP/Azure)
- [ ] CI/CD dashboard access
- [ ] Project management tool (Jira/Linear)

### Tools to Install

- [ ] Node.js 20+ (via [Volta](https://volta.sh/))
- [ ] pnpm 8+
- [ ] Docker Desktop
- [ ] PostgreSQL 15+
- [ ] VS Code or preferred editor
- [ ] Git configured with your work email

## Day 1: Environment Setup

### Step 1: Clone Repository (5 min)

```bash
git clone git@github.com:company/project-name.git
cd project-name
```
````

**Why:** Get the codebase on your machine

**Troubleshooting:**

- SSH key not working? See [GitHub SSH setup](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)
- Permission denied? Ask your manager to verify GitHub access

### Step 2: Install Dependencies (10 min)

```bash
# Install Volta (Node version manager)
curl https://get.volta.sh | bash

# Install dependencies
pnpm install
```

**Expected output:** "Dependencies installed successfully"

**Troubleshooting:**

- `pnpm not found`? Restart terminal or run `volta install pnpm`
- Installation hangs? Check VPN connection

### Step 3: Configure Environment (10 min)

```bash
# Copy environment template
cp .env.example .env
```

**Edit `.env` with these values:**

```
DATABASE_URL=postgresql://postgres:password@localhost:5432/projectname_dev
REDIS_URL=redis://localhost:6379
API_KEY=ask-team-for-dev-key
```

**Get credentials from:**

- Database: Local setup (see next step)
- API keys: Ask @alice or @bob on Slack #dev-onboarding
- External services: Check 1Password vault "Dev Credentials"

**Troubleshooting:**

- Can't find credentials? Post in #dev-onboarding
- Missing env var? Check .env.example for all required variables

### Step 4: Setup Database (15 min)

```bash
# Start PostgreSQL with Docker
docker run --name project-postgres \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  -d postgres:15

# Run migrations
pnpm db:migrate

# Seed with test data
pnpm db:seed
```

**Expected output:** "Migration complete. Database seeded."

**Verify:** Open http://localhost:5432 and check for tables

**Troubleshooting:**

- Port 5432 already in use? Kill existing process: `lsof -ti:5432 | xargs kill`
- Migration fails? Drop and recreate: `pnpm db:reset`

### Step 5: Start Development Server (5 min)

```bash
pnpm dev
```

**Expected output:**

```
✓ Ready on http://localhost:3000
```

**Test:** Open http://localhost:3000 - you should see the homepage

**Troubleshooting:**

- Port 3000 in use? Kill process or change PORT in .env
- Build errors? Clear cache: `rm -rf .next && pnpm dev`

### Step 6: Run Tests (5 min)

```bash
pnpm test
```

**Expected output:** All tests passing ✓

**If tests fail:**

- First time? This is a bug! Report in #dev-help
- Known issue? Check #dev-help pinned messages

## Day 1: Your First Task

### Task: Fix a Starter Issue

We've labeled some issues as `good-first-issue` for new team members.

**Goal:** Successfully complete one small PR to learn our workflow

**Steps:**

1. Browse [good first issues](https://github.com/company/project/labels/good-first-issue)
2. Pick one that interests you (or ask for suggestion in #dev-onboarding)
3. Comment on the issue: "I'll take this!"
4. Create a branch: `git checkout -b fix/issue-123-description`
5. Make your changes
6. Write/update tests
7. Run `pnpm lint` and `pnpm test`
8. Commit following [conventions](./CONTRIBUTING.md#commit-messages)
9. Push and create PR
10. Request review from your mentor

**Estimated time:** 2-4 hours

**Success criteria:**

- [ ] Branch created with proper name
- [ ] Code changes made
- [ ] Tests written/updated
- [ ] All checks passing
- [ ] PR created with description
- [ ] Code reviewed and merged

**Mentors:** @alice (backend), @bob (frontend), @charlie (full-stack)

## Day 2-3: Codebase Tour

### Project Structure Overview

```
src/
├── app/              # Next.js routes (start here!)
│   ├── api/          # API endpoints
│   └── (auth)/       # Authentication pages
├── components/       # React components
│   ├── ui/           # Base UI components
│   └── features/     # Feature-specific components
├── lib/              # Utilities and helpers
│   ├── api/          # API client
│   ├── hooks/        # Custom React hooks
│   └── utils/        # Helper functions
├── services/         # Business logic layer
└── types/            # TypeScript definitions
```

### Key Files to Understand

| File                 | What It Does            | When You'll Touch It    |
| -------------------- | ----------------------- | ----------------------- |
| `src/app/layout.tsx` | Root layout & providers | Adding global providers |
| `src/lib/db.ts`      | Database client         | Database queries        |
| `src/lib/auth.ts`    | Authentication logic    | Auth-related features   |
| `src/middleware.ts`  | Request middleware      | Adding auth/redirects   |

### Walking Tour (Read These Files in Order)

1. **`src/app/page.tsx`** - Homepage (entry point)
2. **`src/app/api/users/route.ts`** - Simple API endpoint
3. **`src/services/user.service.ts`** - Business logic example
4. **`src/components/ui/button.tsx`** - UI component pattern
5. **`src/lib/hooks/useUser.ts`** - Custom hook example

**Exercise:** Find the code that handles user registration. Hint: Start at the API route!

### Common Patterns

**API Route Pattern**

```typescript
// src/app/api/[resource]/route.ts
export async function GET(req: Request) {
  // 1. Validate auth
  // 2. Parse request
  // 3. Call service layer
  // 4. Return response
}
```

**Service Layer Pattern**

```typescript
// src/services/[resource].service.ts
export class UserService {
  async create(data: CreateUserDto) {
    // 1. Validate data
    // 2. Business logic
    // 3. Database operation
    // 4. Return result
  }
}
```

## Week 1: Learning Path

### Day 1

- [ ] Complete environment setup
- [ ] Fix first issue
- [ ] Meet your team (schedule 1:1s)

### Day 2-3

- [ ] Read codebase tour documents
- [ ] Complete second issue (medium complexity)
- [ ] Review 2-3 PRs from teammates

### Day 4-5

- [ ] Work on first feature (with mentor pairing)
- [ ] Attend team standup/planning
- [ ] Set up development tools (linters, extensions)

## Team Structure

### Engineering Team

**Alice (@alice)** - Tech Lead

- Approves architecture decisions
- Code review on complex PRs
- Ask: System design questions

**Bob (@bob)** - Senior Backend Engineer

- Database and API expert
- Ask: Backend, performance questions

**Charlie (@charlie)** - Senior Frontend Engineer

- UI/UX implementation
- Ask: React, styling questions

**Your Manager (@manager)**

- Weekly 1:1s on Fridays 2pm
- Career development discussions
- Ask: Process, priorities, career questions

### Communication Channels

- **#dev-general** - General development discussion
- **#dev-help** - Ask questions, get unstuck
- **#dev-onboarding** - New member support
- **#dev-releases** - Release announcements
- **#dev-alerts** - Production alerts

### Meeting Schedule

- **Daily Standup** - 10:00 AM (15 min)
- **Sprint Planning** - Mondays 2:00 PM (1 hour)
- **Team Retro** - Fridays 4:00 PM (45 min)
- **Tech Talks** - Thursdays 3:00 PM (30 min)

## Development Workflow

### Daily Workflow

1. **Morning:** Check Slack, pull latest main
2. **Standup:** Share yesterday, today, blockers
3. **Code:** Work on assigned tickets
4. **Lunch:** Team usually eats at 12:30
5. **Afternoon:** Continue coding, review PRs
6. **End of day:** Update ticket status, push work

### PR Review Guidelines

When reviewing PRs:

- [ ] Check code quality and style
- [ ] Verify tests cover changes
- [ ] Run the code locally if significant
- [ ] Ask questions if unclear
- [ ] Approve when satisfied

### Getting Code Reviewed

When requesting review:

- [ ] Self-review first
- [ ] Add clear description
- [ ] Link related issues
- [ ] Tag appropriate reviewers
- [ ] Address feedback promptly

## Common Gotchas

### Database

**Problem:** `relation "users" does not exist`
**Solution:** Run migrations: `pnpm db:migrate`

**Problem:** Seed data not appearing
**Solution:** Reset database: `pnpm db:reset`

### Development Server

**Problem:** Changes not reflecting
**Solution:**

1. Hard refresh (Cmd+Shift+R)
2. Clear .next folder: `rm -rf .next`
3. Restart dev server

**Problem:** Port already in use
**Solution:** Kill process: `lsof -ti:3000 | xargs kill`

### Environment

**Problem:** Missing environment variable
**Solution:** Check .env.example, add to your .env

**Problem:** API key not working
**Solution:** Verify it's the dev key, not prod (ask team)

## Resources

### Documentation

- [Architecture Overview](./ARCHITECTURE.md)
- [API Reference](./docs/API.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Style Guide](./docs/STYLE_GUIDE.md)

### Learning Resources

- [Next.js Documentation](https://nextjs.org/docs)
- [Prisma Guides](https://www.prisma.io/docs)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

### Internal Resources

- Company Wiki: https://wiki.company.com
- Design System: https://design.company.com
- API Playground: https://api-dev.company.com

## Getting Help

### When You're Stuck (5-15-30 Rule)

- **5 minutes:** Try to solve it yourself
- **15 minutes:** Search docs, Stack Overflow, past issues
- **30 minutes:** Ask in #dev-help with context

### Good Question Template

```
**What I'm trying to do:** [goal]
**What I tried:** [attempts]
**Error message:** [full error]
**Environment:** [OS, Node version, etc.]
**Related code:** [link to file/line]
```

### Who to Ask

- **Setup issues:** #dev-onboarding or #dev-help
- **Code questions:** #dev-help or your mentor
- **Process questions:** Your manager
- **Urgent/production:** #dev-alerts

## Week 1 Checklist

By end of week 1, you should have:

- [ ] Completed environment setup
- [ ] Fixed 2-3 good-first-issues
- [ ] Created first feature PR
- [ ] Met with all team members
- [ ] Attended all team meetings
- [ ] Read key documentation
- [ ] Understood development workflow
- [ ] Know how to get help

## Feedback

We're always improving onboarding! Please share:

- What went well?
- What was confusing?
- What's missing?

**Share in:** #dev-onboarding or with your manager

---

**Welcome to the team! We're excited to have you here! 🚀**

```

## Onboarding Best Practices

### Time Estimates
- Be realistic with timing
- Include buffer for troubleshooting
- Track actual time vs estimated

### Progressive Complexity
- Day 1: Setup and simple task
- Week 1: Understanding patterns
- Month 1: Independent features

### Clear Success Criteria
- Checklist for each step
- Objective completion markers
- Regular check-ins

### Preemptive Troubleshooting
- Document known issues
- Provide solutions upfront
- Update based on new dev feedback

### Human Connection
- Introduce team members
- Schedule 1:1s
- Provide mentors

## First Task Selection Criteria

Good first task should:
- [ ] Be completable in 2-4 hours
- [ ] Touch multiple areas lightly
- [ ] Have clear acceptance criteria
- [ ] Require PR and review
- [ ] Be genuinely useful (not busy work)
- [ ] Have mentor availability

**Examples:**
- Fix typo in error message (touches: frontend, i18n, testing)
- Add validation to API endpoint (touches: backend, testing, docs)
- Improve loading state (touches: frontend, UX, components)

## Documentation Components

### Essential Sections
1. Prerequisites and access
2. Step-by-step setup with time estimates
3. First task assignment
4. Codebase tour
5. Team structure
6. Communication channels
7. Common issues and solutions
8. Resources and next steps

### Optional but Valuable
- Video walkthrough
- Pair programming schedule
- Reading list
- Architecture diagrams
- Glossary of terms

## Maintenance

### Keep Updated
- Review after each new hire
- Update tool versions
- Refresh access instructions
- Add new common issues

### Collect Feedback
- Exit survey after week 1
- Regular check-ins
- Track time to productivity
- Document pain points

## Output Checklist

Complete onboarding package includes:

- [ ] ONBOARDING.md with step-by-step guide
- [ ] Time estimates for each step
- [ ] First task identified and documented
- [ ] Team structure and communication
- [ ] Troubleshooting for common issues
- [ ] Links to all necessary resources
- [ ] Checklists for progress tracking
- [ ] Feedback mechanism
- [ ] Mentor assignments
- [ ] Expected timeline (day/week/month)
```
