"""Rules that turn checked-in, LLM-written style corpora into app data.

    music_style  validates one corpus at build time (an invalid corpus fails
                 the build), binds hand-picked playback metadata to it, and
                 calibrates loudness by rendering each instrument through the
                 OPL3 synth (see `--output_groups=calibration` for the report).
                 It also declares the instruments and key ranges the style can
                 play (`sound.json`), which the arranger is tested to stay within.
    style_pack   merges styles into the single styles.json the app fetches.
    style_samples packages the sample files the styles can play, offline:
                 from the sample packs each style declares (`packs`, and its
                 `kit`), it copies the files the declared key ranges reach
                 and fails if a range reaches a pack the style does not
                 declare (see `--output_groups=report`, and `superset` for
                 every declared file, which the dev servers serve).

Corpora are (re)written by Claude with `bazel run //tools/generate -- styles/<id>`.
"""

load(":samples.bzl", "SampleKitInfo", "SamplePackInfo")

StyleInfo = provider(
    doc = "A compiled music style.",
    fields = {
        "id": "Style id (string).",
        "bundle": "File: validated corpus + metadata, JSON.",
        "sound": "File: the instruments and key ranges the style can play, JSON.",
        "corpus": "File: the source corpus.",
        "brief": "File or None: the prose brief the corpus was generated from.",
        "kit": "SampleKitInfo or None: the style's own drum kit.",
        "packs": "List of SamplePackInfo: the sample packs the style's instruments play.",
        "label": "Label of the style target.",
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
    inputs = [ctx.file.corpus]
    kit = ctx.attr.kit[SampleKitInfo] if ctx.attr.kit else None
    if kit:
        args.add("--kit", kit.json)
        inputs.append(kit.json)
    ctx.actions.run(
        executable = _stylec(ctx),
        arguments = [args],
        inputs = inputs,
        outputs = [out, report, sound],
        env = {"BAZEL_BINDIR": ctx.bin_dir.path},
        mnemonic = "StyleCompile",
        progress_message = "Validating and loudness-calibrating music style %{label}",
    )
    return [
        DefaultInfo(files = depset([out])),
        OutputGroupInfo(calibration = depset([report])),
        StyleInfo(
            id = style_id,
            bundle = out,
            sound = sound,
            corpus = ctx.file.corpus,
            brief = ctx.file.brief,
            kit = kit,
            packs = [p[SamplePackInfo] for p in ctx.attr.packs],
            label = ctx.label,
        ),
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
        "kit": attr.label(providers = [SampleKitInfo], doc = "The style's drum kit, a sample_kit. Every style declares the ending's drum keys, so style_samples fails without one."),
        "packs": attr.label_list(
            providers = [SamplePackInfo],
            doc = "The sample packs the style plays (@samples//<pack id>): one per instrument program " +
                  "(samples/instruments.json says which); the kit brings its own samples. " +
                  "style_samples fails if a declared key range reaches outside them.",
        ),
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

def _samples_params(ctx, styles):
    """The packaging tool's params: the table, every manifest, and per style its sound and declared files."""
    entries = []
    inputs = [ctx.file._table] + ctx.files._manifests
    for s in styles:
        info = s[StyleInfo]
        files = {}
        for pack in info.packs:
            files.update(pack.files)
        if info.kit:
            files.update(info.kit.samples)
        entries.append({
            "label": str(info.label),
            "sound": info.sound.path,
            "files": {path: f.path for path, f in files.items()},
        })
        inputs.append(info.sound)
        inputs.extend(files.values())
    params = ctx.actions.declare_file(ctx.label.name + ".params.json")
    ctx.actions.write(params, json.encode({
        "rule": str(ctx.label),
        "table": ctx.file._table.path,
        "manifests": [f.path for f in ctx.files._manifests if f.basename == "pack.json"],
        "styles": entries,
    }))
    return params, depset([params] + inputs)

def _style_samples_impl(ctx):
    params, inputs = _samples_params(ctx, ctx.attr.styles)
    out = ctx.actions.declare_directory(ctx.label.name)
    report = ctx.actions.declare_file(ctx.label.name + ".txt")
    ctx.actions.run(
        executable = ctx.attr._samples[DefaultInfo].files_to_run,
        arguments = ["--params", params.path, "--out", out.path, "--report", report.path],
        inputs = inputs,
        outputs = [out, report],
        env = {"BAZEL_BINDIR": ctx.bin_dir.path},
        mnemonic = "StyleSamples",
        progress_message = "Packaging the samples %d styles can play" % len(ctx.attr.styles),
    )

    # Every declared file, for the dev servers: a separate action, run only when asked for.
    superset = ctx.actions.declare_directory(ctx.label.name + "_superset")
    superset_report = ctx.actions.declare_file(ctx.label.name + "_superset.txt")
    ctx.actions.run(
        executable = ctx.attr._samples[DefaultInfo].files_to_run,
        arguments = ["--params", params.path, "--out", superset.path, "--report", superset_report.path, "--superset"],
        inputs = inputs,
        outputs = [superset, superset_report],
        env = {"BAZEL_BINDIR": ctx.bin_dir.path},
        mnemonic = "StyleSamplesSuperset",
        progress_message = "Laying out every sample %d styles declare" % len(ctx.attr.styles),
    )
    return [
        DefaultInfo(files = depset([out])),
        OutputGroupInfo(report = depset([report]), superset = depset([superset])),
    ]

style_samples = rule(
    implementation = _style_samples_impl,
    doc = """The sample files the styles can play, as the site serves them (`samples/`).

    Offline: the files come from the packs each style declares (`packs` on
    music_style, and its `kit`), already downloaded and hash-checked by
    //bazel:samples.bzl. The action runs the sampler's own reach over each
    style's declared ranges, copies only the files that can sound (with the
    program table, the used manifests and credits.json), and fails, naming
    the style, keys and pack, if a range reaches outside the declared packs.
    The `superset` output group holds every declared file instead.
    """,
    attrs = {
        "styles": attr.label_list(providers = [StyleInfo], mandatory = True),
        "_samples": attr.label(default = "//tools/samples", executable = True, cfg = "exec"),
        "_table": attr.label(default = "//samples:instruments.json", allow_single_file = True),
        "_manifests": attr.label(default = "//samples:manifests"),
    },
)
