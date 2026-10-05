/**
 * Minimal static file server for local previews of the built site.
 *
 *   bazel run //site:serve            # http://localhost:8080
 *   PORT=9000 bazel run //site:serve   (falls forward to the next free port if taken)
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function siteRoot(arg: string | undefined): string {
  if (!arg) throw new Error("usage: serve <site-dir>");
  const candidates = [resolve(arg)];
  const runfiles = process.env.JS_BINARY__RUNFILES ?? process.env.RUNFILES_DIR;
  if (runfiles) candidates.push(join(runfiles, "_main", arg));
  const found = candidates.find((c) => existsSync(c) && statSync(c).isDirectory());
  if (!found) throw new Error(`site directory not found: ${candidates.join(", ")}`);
  return found;
}

const root = siteRoot(process.argv[2]);
const requested = Number(process.env.PORT ?? 8080);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path.endsWith("/")) path += "index.html";
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
});

// If the port is taken (e.g. another preview is running), try the next few.
let port = requested;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && port < requested + 10) {
    console.error(`port ${port} is in use, trying ${port + 1}`);
    server.listen(++port);
  } else {
    console.error(`could not start server: ${err.message}`);
    process.exit(1);
  }
});
server.on("listening", () => {
  console.log(`Mindless Midi: http://localhost:${port}/  (serving ${root})`);
});
server.listen(port);
