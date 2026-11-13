---
type: Deployment
title: Deployment
description: CI runs tests and builds on every push; Cloudflare Pages hosts the site and bench; GitHub Pages only redirects old links; manual branch deploys are available.
resource: ../../../.github/workflows
tags: [deploy, ci, cloudflare]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-13T00:00:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: README
---

# Deployment

| Workflow | Does |
| --- | --- |
| `.github/workflows/pages.yml` | `bazel test //...` and `bazel build --config=stamp //site` on every push and PR. From `main` it publishes only `.github/pages-redirect/` to GitHub Pages, forwarding old links (path and session query) to Cloudflare. |
| `.github/workflows/cloudflare.yml` | Builds `//site` and publishes to Cloudflare Pages: production from `main`, a preview URL per same-repo PR. Also deploys `//src/bench:site` as `<project>-bench`. |

Cloudflare setup needs secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
and the variable `CLOUDFLARE_PAGES_PROJECT`; full steps in the README.[^readme]

## Manual deploys

`gh_pages_deploy` targets commit a built site to a branch and push:
`//site:deploy` (`gh-pages`), `//src/mighty:deploy` (`mighty-pages`),
`//src/bench:deploy` (`bench-pages`). Use `--config=stamp` to bake in the
commit hash and `-- --dry-run` first. See the [deploy guide](../guides/deploy.md).

The sites are fully static with relative URLs, so they work from any sub-path
or host, but need a secure context (HTTPS or localhost) for AudioWorklet.

[^readme]: README
