#!/usr/bin/env bash
# Bazel --workspace_status_command: exposes the commit being built, which
# //bazel:stamp.bzl writes into the footer. Only used with --config=stamp.
# CI sets STAMP_COMMIT to the PR head (HEAD there is a synthetic merge commit)
# and GITHUB_REPOSITORY; locally both come from git.
set -euo pipefail

commit="${STAMP_COMMIT:-$(git rev-parse HEAD)}"
repo="${GITHUB_REPOSITORY:-$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')}"
echo "STABLE_GIT_COMMIT $commit"
echo "STABLE_GIT_REPO $repo"
