/**
 * Minimal static file server for local previews of the built site.
 *
 *   bazel run //site:serve            # http://localhost:8080
 *   PORT=9000 bazel run //site:serve   (falls forward to the next free port if taken)
 *
 *   serve <site-dir> [<prefix>=<dir>]...
 *
 * A `<prefix>=<dir>` mount serves `/<prefix>/...` from that directory instead
 * of the site's: the dev servers serve `samples/` from every file the styles'
 * sample packs hold (//styles:samples_superset), not the trimmed slice the
 * site ships, so a page that plays beyond the declared ranges still finds them.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
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
// `<prefix>=~/dir?`: a folder in the home directory, skipped with a note if it is missing (local media kept out of the repo).
const mounts = process.argv.slice(3).flatMap((m) => {
  const [prefix, spec] = m.split("=");
  if (!prefix || !spec) throw new Error(`expected <prefix>=<dir>, not ${m}`);
  const optional = spec.endsWith("?");
  const dir = spec.replace(/\?$/, "").replace(/^~(?=\/)/, homedir());
  if (optional && !(existsSync(dir) && statSync(dir).isDirectory())) {
    console.error(`${prefix}/: ${dir} not found, not served`);
    return [];
  }
  return [{ prefix: `/${prefix.replace(/^\/+|\/+$/g, "")}/`, dir: siteRoot(dir) }];
});
const requested = Number(process.env.PORT ?? 8080);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // The page's ?perf readout reports here, one JSON line per second, for reading in this server's log.
  if (req.method === "POST" && url.pathname === "/__perf") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      if (body.length < 16_384) body += chunk.toString();
    });
    req.on("end", () => {
      console.log(`[perf] ${req.socket.remoteAddress} ${body}`);
      res.writeHead(204).end();
    });
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path.endsWith("/")) path += "index.html";
  const mount = mounts.find((m) => path.startsWith(m.prefix));
  const base = mount?.dir ?? root;
  const file = mount ? join(base, path.slice(mount.prefix.length)) : join(root, path);
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const size = statSync(file).size;
  // Byte ranges, which video elements need to seek (Safari will not play without them).
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { "content-type": type, "cache-control": "no-store", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    "accept-ranges": "bytes",
    "content-length": size,
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
  console.log(`Mindless Midi: http://localhost:${port}/  (serving ${root}${mounts.map((m) => `, ${m.prefix} from ${m.dir}`).join("")})`);
});
server.listen(port);
