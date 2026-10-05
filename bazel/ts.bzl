"""Thin conventions over rules_ts / rules_js for this repo."""

load("@aspect_rules_js//js:defs.bzl", "js_binary", "js_test")
load("@aspect_rules_ts//ts:defs.bzl", "ts_project")

def ts_lib(name, srcs, deps = [], node = False, **kwargs):
    """A TypeScript library. `node = True` compiles against Node types instead of the DOM."""
    ts_project(
        name = name,
        srcs = srcs,
        declaration = True,
        tsconfig = "//:tsconfig_node" if node else "//:tsconfig",
        deps = deps + (["//:node_modules/@types/node"] if node else []),
        **kwargs
    )

def ts_test(name, src, deps = [], data = [], **kwargs):
    """A `node:test` test written in TypeScript."""
    ts_lib(
        name = name + "_lib",
        srcs = [src],
        deps = deps,
        node = True,
        testonly = True,
    )
    js_test(
        name = name,
        data = [name + "_lib"] + data,
        entry_point = src.replace(".ts", ".js"),
        **kwargs
    )

def ts_binary(name, src, deps = [], data = [], **kwargs):
    """A Node CLI written in TypeScript."""
    ts_lib(
        name = name + "_lib",
        srcs = [src],
        deps = deps,
        node = True,
    )
    js_binary(
        name = name,
        data = [name + "_lib"] + data,
        entry_point = src.replace(".ts", ".js"),
        **kwargs
    )
