---
name: consistency
description: "Always-on skill that enforces project conventions. Read CONVENTIONS.md before writing any code and ensure all changes follow canonical action patterns and behavioral rules."
trigger: "Before writing any code in this project"
---

# Consistency Enforcement

This skill ensures all code changes follow the project's established conventions.

## Process

1. **Read conventions first.** At the start of every coding session, read `CONVENTIONS.md` at the project root. It documents canonical implementations of repeated user actions and cross-cutting behavioral rules.

2. **Identify relevant conventions.** Before writing code, determine which canonical actions and behavioral rules apply to the current task.

3. **Follow canonical actions exactly.** When implementing an action that has a canonical entry in CONVENTIONS.md, replicate that entry's flow exactly — the same invoke calls, state updates, user feedback, and error handling. Do not deviate or create alternative implementations.

4. **Fix violations as you go.** When touching a file that has existing violations (silent `.catch(() => {})`, missing `addLog()` for network operations, inconsistent action implementations), fix those violations as part of the current work. "Nearby" means the same function or directly related functions — don't refactor unrelated parts of the file.

5. **Flag new repeated actions.** If adding a new action that will appear in multiple places but doesn't have a canonical entry yet, flag it to the user and suggest adding it to CONVENTIONS.md.

## Scope

This skill:
- Applies to every coding session in this project
- Covers both frontend (TypeScript/React) and backend (Rust) code
- Enforces action consistency and behavioral rules from CONVENTIONS.md

This skill does NOT:
- Run as a post-implementation linter or audit
- Enforce code-style rules (naming, formatting)
- Touch files unrelated to the current task
