---
type: Guide
title: Deploy
description: How changes reach production (merge to main) and how to push a site branch by hand.
tags: [guide, deploy]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
---

# Deploy

Normally: merge to `main`. CI tests, builds and publishes to Cloudflare Pages;
PRs from the same repo get preview URLs. See [deployment](../build/deployment.md).

By hand, to a branch:

```bash
bazel run --config=stamp //site:deploy -- --dry-run
```

Drop `--dry-run` to push. The same works for `//src/mighty:deploy` and
`//src/bench:deploy`.
