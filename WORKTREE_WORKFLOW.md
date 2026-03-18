# Git Worktree Workflow with Claude Code

## Setup (one-time)

Make sure your main repo has a clean state and your work is committed:

```bash
cd /Users/alex/viboplr
git status  # should be clean
```

## Phase 1: Create the worktree

**Option A — Automatic (Claude Code)**
```bash
claude --worktree "description of the task"
```
Claude creates the branch, worktree directory, and starts working.

**Option B — Manual**
```bash
git worktree add ../viboplr-feature-x -b feature-x
cd ../viboplr-feature-x
claude
```

## Phase 2: Work in the worktree

```bash
git worktree list                # list all active worktrees
cd ../viboplr-feature-x      # navigate to the worktree
npm install                      # install dependencies (separate node_modules)
npm run tauri dev                # work normally
```

**Rules:**
- Do NOT `git checkout main` inside the worktree — change directories instead
- Each worktree = one branch, always
- You can have multiple worktrees running simultaneously

## Phase 3: Keep in sync with main

```bash
# Inside the worktree
git fetch origin
git rebase main   # or: git merge main
```

## Phase 4: Test

```bash
cd ../viboplr-feature-x
npx tsc --noEmit                          # frontend type-check
cd src-tauri && cargo check && cd ..      # rust check
npm run tauri dev                          # full run
```

## Phase 5: Merge back to main

**Option A — Direct merge**
```bash
cd /Users/alex/viboplr
git merge feature-x
```

**Option B — PR workflow (recommended)**
```bash
cd ../viboplr-feature-x
git push origin feature-x
# Create PR on GitHub, review, merge
```

**Option C — Rebase for clean history**
```bash
cd /Users/alex/viboplr
git rebase feature-x
```

## Phase 6: Clean up

```bash
git worktree remove ../viboplr-feature-x
git branch -d feature-x
git worktree list   # verify
```

## Quick reference

| Action | Command |
|---|---|
| List worktrees | `git worktree list` |
| Create worktree | `git worktree add <path> -b <branch>` |
| Create with Claude | `claude --worktree "task"` |
| Sync with main | `git merge main` (inside worktree) |
| Merge to main | `git merge <branch>` (inside main) |
| Remove worktree | `git worktree remove <path>` |
| Delete branch | `git branch -d <branch>` |
| Force remove | `git worktree remove --force <path>` |

## Common mistakes to avoid

1. **Checking out the same branch in two worktrees** — Git blocks this
2. **Forgetting `npm install`** — each worktree has separate node_modules
3. **Deleting the directory instead of `git worktree remove`** — leaves stale refs; fix with `git worktree prune`
4. **Merging before testing** — always build and run in the worktree first
