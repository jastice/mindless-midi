# Build and tooling

Everything (corpus validation, loudness calibration, bundling, the static
sites, the dev servers, deployment) is a Bazel target.

- [Bazel rules](./bazel-rules.md) - The custom rules in `bazel/` and the third-party rule sets
- [Tools](./tools.md) - The programs in `tools/`: generate, stylec, samples, render, serve, social
- [Samples](./samples.md) - How recorded instruments are declared, fetched, hash-pinned and served
- [Deployment](./deployment.md) - CI workflows, Cloudflare Pages, the GitHub Pages redirect, manual deploys
- [Agent skills](./agent-skills.md) - Repo-local skills for coding agents, managed by rules_agents
