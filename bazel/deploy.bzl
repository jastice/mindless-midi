"""Publish a built static site to a git branch (GitHub Pages style)."""

def _gh_pages_deploy_impl(ctx):
    site = ctx.file.site
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.expand_template(
        template = ctx.file._template,
        output = script,
        substitutions = {
            "{{SITE}}": site.short_path,
            "{{BRANCH}}": ctx.attr.branch,
            "{{REMOTE}}": ctx.attr.remote,
            "{{MESSAGE}}": ctx.attr.message,
        },
        is_executable = True,
    )
    return [DefaultInfo(executable = script, runfiles = ctx.runfiles(files = [site]))]

gh_pages_deploy = rule(
    implementation = _gh_pages_deploy_impl,
    doc = """`bazel run` target that commits the site to a branch and pushes it.

    Pass `-- --dry-run` to build the commit locally without pushing. The CI
    workflow in .github/workflows/pages.yml deploys via GitHub's Pages
    artifact flow instead; this is the manual alternative.
    """,
    executable = True,
    attrs = {
        "site": attr.label(allow_single_file = True, mandatory = True, doc = "Directory to publish."),
        "branch": attr.string(default = "gh-pages"),
        "remote": attr.string(default = "origin"),
        "message": attr.string(default = "Deploy Mindless Midi"),
        "_template": attr.label(default = "//bazel:gh_pages_deploy.sh.tpl", allow_single_file = True),
    },
)
