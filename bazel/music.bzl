"""Rules that turn checked-in, LLM-written style corpora into app data.

    music_style  validates one corpus at build time (an invalid corpus fails
                 the build), binds hand-picked playback metadata to it, and
                 calibrates loudness by rendering each instrument through the
                 OPL3 synth (see `--output_groups=calibration` for the report).
    style_pack   merges styles into the single styles.json the app fetches.

Corpora are (re)written by Claude with `bazel run //tools/generate -- styles/<id>`.
"""

StyleInfo = provider(
    doc = "A compiled music style.",
    fields = {
        "id": "Style id (string).",
        "bundle": "File: validated corpus + metadata, JSON.",
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
    args = ctx.actions.args()
    args.add("bundle")
    args.add("--corpus", ctx.file.corpus)
    args.add("--id", style_id)
    args.add("--bank", str(ctx.attr.bank))
    args.add("--color", ctx.attr.color)
    args.add("--out", out)
    args.add("--report", report)
    ctx.actions.run(
        executable = _stylec(ctx),
        arguments = [args],
        inputs = [ctx.file.corpus],
        outputs = [out, report],
        env = {"BAZEL_BINDIR": ctx.bin_dir.path},
        mnemonic = "StyleCompile",
        progress_message = "Validating and loudness-calibrating music style %{label}",
    )
    return [
        DefaultInfo(files = depset([out])),
        OutputGroupInfo(calibration = depset([report])),
        StyleInfo(id = style_id, bundle = out, corpus = ctx.file.corpus, brief = ctx.file.brief),
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
