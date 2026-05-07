# DEVLOG

A running log of what I shipped, why, and what I learned. Append-only.

## 2026-05-07 · Autonomous pre-commit review

Wired up an autonomous code reviewer that fires on every git commit. Husky pre-commit hook calls a bash runner. The runner classifies staged files by path (security-sensitive, source code, tests, docs), determines the strictest severity, picks a model (Sonnet 4.6 by default, Opus 4.7 for security-sensitive paths), and pipes the diff plus full file context to `claude` in headless mode. Review prints to terminal, parses the `VERDICT:` line, exits 0 or 1.

Four commits today. Two of them are the meta-story.

The first commit added the reviewer. The second hardened it against secret leakage: any file matching `.env`, key/cert patterns, SSH keys, cloud credentials, or known-private folders gets hard-excluded from the cloud API entirely. Listed for manual review instead. Asymmetric risk: false positives cost ten seconds, false negatives leak credentials forever.

The third commit was a "cleanup" that deleted what I thought was a redundant regex. It wasn't redundant. The deleted line covered suffix-style env files (`staging.env`, `production.env`). The reviewer caught the regression on that commit's own review pass and flagged it as a `[Low]` note. I almost shipped past it because the verdict line said PASS. Lesson: read the body notes, not just the verdict.

The fourth commit restored the regex with an anti-collapse comment so I don't repeat the mistake.

What's next: run the workflow for two weeks, watch the bypass rate, see what real friction emerges. Add a DEVLOG entry per meaningful ship.
