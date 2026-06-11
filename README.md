# pi-specialized-review

A Pi extension for Cloudflare-style specialized code review: one coordinator inspects the current git diff, selects a small set of non-overlapping reviewer roles, runs them through `pi-subagents`, and synthesizes the results.

This package intentionally exports **only one Pi extension**. It does not export Pi prompt templates, skills, themes, or discoverable subagent definitions. The reviewer contracts live in `reviewers/*.md` as private package files and are injected into a review run only when `/specialized-review` is invoked.

## Requirements

Install `pi-subagents` first or alongside this package:

```bash
pi install npm:pi-subagents
```

Then install this package from a local checkout, git repo, or npm package:

```bash
pi install ./pi-specialized-review
# or, while testing without adding it to settings:
pi -e ./pi-specialized-review
```

Run `/reload` after changing the extension or reviewer files in an active Pi session.

## Commands

```text
/specialized-review
/specialized-review staged
/specialized-review autofix
/specialized-review security api focus auth changes
/specialized-review --all
/specialized-reviewers
```

`/specialized-review` inspects git metadata with read-only commands, selects reviewers, and sends a follow-up coordinator prompt that calls `subagent` with the built-in `reviewer` agent. Each child receives a fresh context by default, `skill: false`, and exactly one private specialist contract.

`/specialized-reviewers` shows the private reviewer catalog.

## Flags and arguments

| Argument | Meaning |
| --- | --- |
| `staged` or `--staged` | Review `git diff --cached` instead of the unstaged diff. |
| `autofix` or `--autofix` | After synthesis, apply only small safe `fix_now` edits and run focused validation. |
| `all` or `--all` | Run every reviewer. Useful for large/high-risk changes, expensive for small diffs. |
| `fork` or `--fork` | Ask subagents to use forked parent session context instead of fresh context. |
| reviewer names | Force reviewers, for example `security`, `api`, `docs`, `performance`, `sr-release-risk`. |
| anything else | Passed through as user focus. |

## Reviewer catalog

The private reviewer contracts are in `reviewers/`. Each Markdown file is the source of truth for its catalog label, user-facing catalog description, aliases, ordering, and private role contract. `/specialized-reviewers` renders the installed catalog from that frontmatter instead of from duplicated extension metadata.

## How it avoids leaking into your setup

The package manifest contains only:

```json
{
  "pi": {
    "extensions": ["./extensions/specialized-review.js"]
  }
}
```

There is no `pi.prompts`, no `pi.skills`, and no `.pi/agents` or `agents/` directory. Pi will load the slash-command extension, while the Markdown reviewer specs stay private package data.

At runtime, the command uses the already-installed `pi-subagents` tool. It does **not** create persistent subagent files and it does **not** ask `pi-subagents` to discover these reviewer specs as agents.

## Evolution path

This layout is meant to evolve as its own package:

```text
pi-specialized-review/
  package.json
  extensions/
    specialized-review.js
  reviewers/
    sr-correctness.md
    sr-tests.md
    sr-security.md
    sr-performance.md
    sr-api-contracts.md
    sr-release-risk.md
    sr-docs.md
    sr-maintainability.md
```

Good next steps are deterministic review policy configuration, per-project reviewer overrides, structured result parsing, CI/PR integration, and optional model routing per reviewer.
