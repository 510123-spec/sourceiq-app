# SourceIQ — Claude Code Project

## gstack

Use the `/browse` skill from gstack for all web browsing tasks. Never use `mcp__claude-in-chrome__*` tools directly.

### First-time setup (run once after cloning)

```bash
git submodule update --init --depth 1
cd .claude/skills/gstack && ./setup
```

Available gstack skills:
- `/office-hours` — guided Q&A and planning session
- `/plan-ceo-review` — CEO-level plan review
- `/plan-eng-review` — engineering plan review
- `/plan-design-review` — design plan review
- `/design-consultation` — design consultation session
- `/design-shotgun` — rapid parallel design exploration
- `/design-html` — generate HTML designs
- `/review` — code review
- `/ship` — ship a change
- `/land-and-deploy` — land and deploy to production
- `/canary` — canary deployment
- `/benchmark` — performance benchmarking
- `/browse` — headless web browsing (use this for all web browsing)
- `/connect-chrome` — connect to Chrome browser
- `/qa` — full QA run
- `/qa-only` — QA without build
- `/design-review` — review designs
- `/setup-browser-cookies` — set up browser cookies
- `/setup-deploy` — configure deployment
- `/setup-gbrain` — configure gbrain
- `/retro` — retrospective
- `/investigate` — investigate an issue
- `/document-release` — document a release
- `/document-generate` — generate documentation
- `/codex` — code search and indexing
- `/cso` — chief strategy officer review
- `/autoplan` — automated planning
- `/plan-devex-review` — developer experience plan review
- `/devex-review` — developer experience review
- `/careful` — careful/cautious mode for risky changes
- `/freeze` — freeze the codebase
- `/guard` — guard against regressions
- `/unfreeze` — unfreeze the codebase
- `/gstack-upgrade` — upgrade gstack
- `/learn` — learning and onboarding
