---
name: github-issue-driven-dev
description: "Fix a GitHub issue end-to-end: branch, commit, PR, close."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [GitHub, Issues, Pull-Requests, Git, Workflow, Bug-Fixing, Contributing]
    related_skills: [github-auth, github-issues, github-pr-workflow]
---

# GitHub Issue-Driven Development

Complete workflow for taking a GitHub issue from open to closed via a pull request. This skill covers the connective tissue between issue management and PR workflow — the actual developer loop of picking an issue, branching, fixing, and shipping.

## Prerequisites

- Authenticated with GitHub (see `github-auth` skill)
- Inside a git repository with a GitHub remote, on a clean working tree

### Quick Setup

```bash
if command -v gh &>/dev/null && gh auth status &>/dev/null; then
  AUTH="gh"
else
  AUTH="curl"
  GITHUB_TOKEN="${GITHUB_TOKEN:-$(grep "^GITHUB_TOKEN=" ~/.hermes/.env 2>/dev/null | cut -d= -f2 | tr -d '\n\r')}"
fi

REMOTE_URL=$(git remote get-url origin)
OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's|.*github\.com[:/]||; s|\.git$||')
OWNER=$(echo "$OWNER_REPO" | cut -d/ -f1)
REPO=$(echo "$OWNER_REPO" | cut -d/ -f2)
```

---

## Step 1 — Pick an Issue to Work

Find an issue that needs attention — unassigned bugs, help-wanted items, or a specific number.

**With gh:**

```bash
# Find unassigned open bugs
gh issue list --state open --label "bug" --assignee "" --limit 10

# Find help-wanted issues
gh issue list --state open --label "help wanted" --limit 10

# View a specific issue before committing to it
gh issue view 42
```

**With curl:**

```bash
# Unassigned open issues
curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues?state=open&labels=bug&per_page=10" \
  | python3 -c "
import sys, json
for i in json.load(sys.stdin):
    if 'pull_request' not in i and not i['assignees']:
        labels = ', '.join(l['name'] for l in i['labels'])
        print(f\"#{i['number']:5}  {labels:30}  {i['title']}\")"

# View a specific issue
curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/42" \
  | python3 -c "
import sys, json
i = json.load(sys.stdin)
print(f\"#{i['number']}: {i['title']}\")
print(f\"State: {i['state']}  Author: {i['user']['login']}\")
print(f\"\n{i['body']}\")"
```

---

## Step 2 — Claim the Issue

Self-assign to signal you're working on it. Comment if it's an external repo (you may not have write access to assign).

**With gh (own repo or collaborator):**

```bash
gh issue edit 42 --add-assignee @me
gh issue comment 42 --body "Working on this — will submit a PR shortly."
```

**With gh (external fork contribution — no write access):**

```bash
# Can't self-assign on external repos — just comment
gh issue comment 42 --body "I'd like to work on this. Starting now."
```

**With curl:**

```bash
# Self-assign (requires write access)
GH_USER=$(curl -s -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/user | python3 -c "import sys,json; print(json.load(sys.stdin)['login'])")
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/42/assignees" \
  -d "{\"assignees\": [\"$GH_USER\"]}"

# Comment
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/42/comments" \
  -d '{"body": "Working on this — will submit a PR shortly."}'
```

---

## Step 3 — Create a Branch

Branch naming follows the repo convention — check `CONTRIBUTING.md` first. Common patterns: `fix/issue-42-short-description`, `feat/issue-42-description`.

**With gh (creates branch and checks it out):**

```bash
# Automatic — gh infers branch name from issue title
gh issue develop 42 --checkout

# Manual name
gh issue develop 42 --name "fix/issue-42-login-redirect" --checkout
```

**With git:**

```bash
# Always branch from the upstream default branch, not your local stale copy
git fetch origin
git checkout -b fix/issue-42-login-redirect origin/main
# or origin/master, origin/dev — check what the default branch is
```

Verify you're on the right base:

```bash
git log --oneline -3
git status  # should be clean
```

---

## Step 4 — Work the Issue

Make your changes. Keep the scope tight — one logical fix per branch.

**Checkpoints while working:**

```bash
# Re-read the issue periodically to stay on scope
gh issue view 42

# Run existing tests before and after your change
# (check CONTRIBUTING.md for the test command — commonly one of:)
pytest tests/ -v
npm test
make test

# Check what you've changed
git diff
git diff --stat
```

**Commit incrementally with clear messages:**

```bash
# Conventional commit format (common in open source):
git commit -m "fix(auth): respect ?next= parameter on login redirect

Closes #42"

# The "Closes #42" in the commit body is optional here — it's more
# reliable to put it in the PR description. But it's useful for context.
```

---

## Step 5 — Verify Before Opening a PR

Run the full test suite. Check cross-platform concerns if you touched I/O, process management, or terminal handling.

```bash
# Full test run
pytest tests/ -v           # Python
npm test                   # Node
go test ./...              # Go

# Lint / type check if the project has it
# (check CONTRIBUTING.md for the exact commands)

# Manual smoke test — actually run the code and exercise the changed path
```

If tests fail, fix before opening the PR.

---

## Step 6 — Push and Open a Pull Request

Push to your fork (if contributing to an external project) or directly to the repo.

**With gh:**

```bash
# Push and open PR in one step
gh pr create \
  --title "fix(auth): respect ?next= parameter on login redirect" \
  --body "## What changed
Respects the \`?next=\` query parameter after login instead of always redirecting to \`/dashboard\`.

## How to test
1. Navigate to a protected page while logged out (e.g., \`/settings\`)
2. Log in
3. Confirm you land on \`/settings\`, not \`/dashboard\`

## Platform tested
- Linux (Ubuntu 22.04)

Closes #42"
```

**With git + curl:**

```bash
git push origin fix/issue-42-login-redirect

# Open PR via API
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/pulls" \
  -d '{
    "title": "fix(auth): respect ?next= parameter on login redirect",
    "body": "## What changed\nRespects the `?next=` query parameter after login.\n\n## How to test\n1. Navigate to /settings while logged out\n2. Log in\n3. Confirm you land on /settings\n\nCloses #42",
    "head": "your-fork-username:fix/issue-42-login-redirect",
    "base": "main"
  }'
```

### PR Description Template

```
## What changed
<1-3 sentences on what the fix does>

## Why
<Brief context — link to the issue, explain the root cause>

## How to test
1. <step>
2. <step>
3. <expected result>

## Platform tested
- <OS and version>

Closes #<issue-number>
```

---

## Step 7 — Follow Through

After opening the PR:

```bash
# Check CI status
gh pr checks

# View review comments
gh pr view --comments

# Push fixes for review feedback
git add .
git commit -m "fix: address review feedback"
git push origin fix/issue-42-login-redirect

# Once approved and merged, clean up
git checkout main
git pull origin main
git branch -d fix/issue-42-login-redirect
```

---

## Contributing to External Repos (Fork Workflow)

When contributing to a repo you don't own:

```bash
# 1. Fork on GitHub (web UI or gh)
gh repo fork OWNER/REPO --clone=false

# 2. Add your fork as a remote (if you already have the repo cloned)
git remote add fork https://github.com/YOUR_USERNAME/REPO.git

# 3. Branch from the upstream default
git fetch origin
git checkout -b fix/issue-42-description origin/main

# 4. Work, commit, push to YOUR FORK
git push fork fix/issue-42-description

# 5. Open PR from your fork to the upstream repo
gh pr create --repo OWNER/REPO \
  --title "fix: short description" \
  --body "Closes #42"
```

---

## Quick Reference

| Step | gh | git/curl |
|------|-----|---------|
| Pick issue | `gh issue list --label "bug"` | `GET /repos/{o}/{r}/issues` |
| View issue | `gh issue view N` | `GET /repos/{o}/{r}/issues/N` |
| Self-assign | `gh issue edit N --add-assignee @me` | `POST /issues/N/assignees` |
| Comment | `gh issue comment N --body "..."` | `POST /issues/N/comments` |
| Create branch | `gh issue develop N --checkout` | `git checkout -b fix/N-desc origin/main` |
| Check CI | `gh pr checks` | `GET /repos/{o}/{r}/commits/{sha}/check-runs` |
| Open PR | `gh pr create ...` | `POST /repos/{o}/{r}/pulls` |
| Clean up | `git branch -d fix/N-desc` | same |
