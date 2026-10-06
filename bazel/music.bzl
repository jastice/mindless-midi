"""Rules that turn checked-in, LLM-written style corpora into app data.

    music_style  validates one corpus at build time (an invalid corpus fails
                 the build), binds hand-picked playback metadata to it, and
                 calibrates loudness by rendering each instrument through the
                 OPL3 synth (see `--output_groups=calibration` for the report).
                 It also declares the instruments and key ranges the style can
                 play (`sound.json`), which the arranger is tested to stay within.
    style_pack   merges styles into the single styles.json the app fetches.
    style_samples fetches the sample files those declarations name, so the
                 site serves its own samples (see `--output_groups=report`).

Corpora are (re)written by Claude with `bazel run //tools/generate -- styles/<id>`.
"""

StyleInfo = provider(
    doc = "A compiled music style.",
    fields = {
        "id": "Style id (string).",
        "bundle": "File: validated corpus + metadata, JSON.",
        "sound": "File: the instruments and key ranges the style can play, JSON.",
        "corpus": "File: the source corpus.",
        "brief": "File or None: the prose brief the corpus was generated from.",
    },
)

def _stylec(ctx):
    return ctx.attr._stylec[DefaultInfo].files_to_run

def _music_style_impl(ctx):
    style_id = ctx.attr.style_id or ctx.label.package.split("/")[-1]
    out = ctx.actions.declare_file(ctx.label.name + ".style.json")
    report = ctx.actions.declare_file(ctx.label.name + ".calibration.txt")
    sound = ctx.actions.declare_file(ctx.label.name + ".sound.json")
    args = ctx.actions.args()
    args.add("bundle")
    args.add("--corpus", ctx.file.corpus)
    args.add("--id", style_id)
    args.add("--bank", str(ctx.attr.bank))
    args.add("--color", ctx.attr.color)
    args.add("--out", out)
    args.add("--report", report)
    args.add("--sound", sound)
    ctx.actions.run(
        executable = _stylec(ctx),
        arguments = [args],
        inputs = [ctx.file.corpus],
        outputs = [out, report, sound],
        env = {"BAZEL_BINDIR": ctx.bin_dir.path},
        mnemonic = "StyleCompile",
        progress_message = "Validating and loudness-calibrating music style %{label}",
    )
    return [
        DefaultInfo(files = depset([out])),
        OutputGroupInfo(calibration = depset([report])),
        StyleInfo(id = style_id, bundle = out, sound = sound, corpus = ctx.file.corpus, brief = ctx.file.brief),
    ]

_TOOL = attr.label(default = "//tools/stylec", executable = True, cfg = "exec")

music_style = rule(
    implementation = _music_style_impl,
    doc = "Validates a style corpus and binds playback metadata to it.",
    attrs = {
        "corpus": attr.label(allow_single_file = [".json"], mandatory = True, doc = "Corpus JSON written by //tools/generate."),
        "brief": attr.label(allow_single_file = [".md"], doc = "Prose brief the corpus is generated from."),
        "style_id": attr.string(doc = "Defaults to the package's directory name."),
        "bank": attr.int(mandatory = True, doc = "libADLMIDI embedded FM bank number."),
        "color": attr.string(default = "#888888", doc = "UI accent colour."),
        "_stylec": _TOOL,
    },
    provides = [StyleInfo],
)

def _style_pack_impl(ctx):
    out = ctx.actions.declare_file(ctx.attr.out or ctx.label.name + ".json")
    bundles = [s[StyleInfo].bundle for s in ctx.attr.styles]
    args = ctx.actions.args()
    args.add("pack")
    args.add("--out", out)
    args.add_all(bundles)
    ctx.actions.run(
        executable = _stylec(ctx),
        arguments = [args],
        inputs = bundles,
        outputs = [out],
        env = {"BAZEL_BINDIR": ctx.bin_dir.path},
        mnemonic = "StylePack",
        progress_message = "Packing %d music styles into %%{output}" % len(bundles),
    )
    return [DefaultInfo(files = depset([out]))]

style_pack = rule(
    implementation = _style_pack_impl,
    doc = "Merges music styles into one JSON file, in the given order.",
    attrs = {
        "styles": attr.label_list(providers = [StyleInfo], mandatory = True),
        "out": attr.string(doc = "Output file name; defaults to <name>.json."),
        "_stylec": _TOOL,
    },
)

def _style_samples_impl(ctx):
    out = ctx.actions.declare_directory(ctx.label.name)
    report = ctx.actions.declare_file(ctx.label.name + ".txt")
    hashes = ctx.actions.declare_file(ctx.label.name + ".hashes.json")
    sounds = [s[StyleInfo].sound for s in ctx.attr.styles]
    args = ctx.actions.args()
    args.add("--out", out.path)
    args.add("--report", report)
    args.add("--emit-lock", hashes)
    inputs = list(sounds)
    if ctx.file.lock:
        args.add("--lock", ctx.file.lock)
        inputs.append(ctx.file.lock)
    args.add_all(sounds)
    ctx.actions.run(
        executable = ctx.attr._samples[DefaultInfo].files_to_run,
        arguments = [args],
        inputs = inputs,
        outputs = [out, report, hashes],
        env = {"BAZEL_BINDIR": ctx.bin_dir.path},
        # Downloads from the upstream sample hosts. The result is cached by the
        # declarations, so it only runs again when a style's sound changes.
        execution_requirements = {"requires-network": "1"},
        mnemonic = "StyleSamples",
        progress_message = "Fetching the samples %d styles can play" % len(sounds),
    )
    return [
        DefaultInfo(files = depset([out])),
        OutputGroupInfo(report = depset([report]), hashes = depset([hashes])),
    ]

_style_samples = rule(
    implementation = _style_samples_impl,
    attrs = {
        "styles": attr.label_list(providers = [StyleInfo], mandatory = True),
        "lock": attr.label(allow_single_file = [".json"]),
        "_samples": attr.label(default = "//tools/samples", executable = True, cfg = "exec"),
    },
)

def _samples_lock_update_impl(ctx):
    fresh = ctx.attr.fresh[OutputGroupInfo].hashes.to_list()[0]
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(
        output = script,
        is_executable = True,
        content = """#!/usr/bin/env bash
set -euo pipefail
src="${{RUNFILES_DIR:-$0.runfiles}}/_main/{src}"
dest="${{BUILD_WORKSPACE_DIRECTORY:?run me with bazel run}}/{dest}"
cp "$src" "$dest"
chmod u+w "$dest"
echo "pinned $(grep -c '": "' "$dest") files in {dest}"
""".format(src = fresh.short_path, dest = ctx.attr.dest),
    )
    return [DefaultInfo(executable = script, runfiles = ctx.runfiles(files = [fresh]))]

_samples_lock_update = rule(
    implementation = _samples_lock_update_impl,
    executable = True,
    attrs = {
        "fresh": attr.label(mandatory = True, providers = [OutputGroupInfo]),
        "dest": attr.string(mandatory = True),
    },
)

def style_samples(name, styles, lock, **kwargs):
    """Fetches the sample files the styles' sound declarations name.

    The output directory holds `danigb/...` and `gleitz/...`, which the page
    serves as `samples/` and fetches instead of the upstream hosts.

    `lock` is the checked-in pin: a JSON map of file path to sha256 that every
    download must match, so a build can't pick up a changed or unlisted file.
    `bazel run //<package>:<name>_lock` fetches afresh and rewrites the pin,
    for when the styles (and so the file list) or upstream change on purpose.
    """
    _style_samples(name = name, styles = styles, lock = lock, **kwargs)
    _style_samples(name = name + "_fresh", styles = styles, tags = ["manual"])
    _samples_lock_update(
        name = name + "_lock",
        fresh = ":" + name + "_fresh",
        dest = native.package_name() + "/" + lock.lstrip(":"),
        tags = ["manual"],
    )
