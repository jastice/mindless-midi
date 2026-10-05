"""Stamp the footer of index.html with the commit it was built from."""

def _stamp_build_info_impl(ctx):
    out = ctx.actions.declare_file(ctx.attr.out)
    # stable-status.txt only carries STABLE_GIT_* under --config=stamp; without
    # it the marker is simply dropped, so unstamped builds stay cacheable.
    ctx.actions.run_shell(
        inputs = [ctx.file.src, ctx.info_file],
        outputs = [out],
        command = """
set -euo pipefail
commit="$(sed -n 's/^STABLE_GIT_COMMIT //p' "$1")"
repo="$(sed -n 's/^STABLE_GIT_REPO //p' "$1")"
if [[ -n "$commit" ]]; then
  link="<p class=\\"build\\">Build <a href=\\"https://github.com/$repo/commit/$commit\\"><code>${commit:0:7}</code></a></p>"
else
  link=""
fi
sed "s|<!-- @BUILD@ -->|$link|" "$2" > "$3"
""",
        arguments = [ctx.info_file.path, ctx.file.src.path, out.path],
        mnemonic = "StampBuildInfo",
    )
    return [DefaultInfo(files = depset([out]))]

stamp_build_info = rule(
    implementation = _stamp_build_info_impl,
    doc = """Replaces the `<!-- @BUILD@ -->` marker in `src` with a link to the
    built commit on GitHub. Needs `--config=stamp`; otherwise the marker is removed.""",
    attrs = {
        "src": attr.label(allow_single_file = True, mandatory = True),
        "out": attr.string(mandatory = True),
    },
)
