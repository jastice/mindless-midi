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
const mounts = process.argv.slice(3).map((m) => {
  const [prefix, dir] = m.split("=");
  if (!prefix || !dir) throw new Error(`expected <prefix>=<dir>, not ${m}`);
  return { prefix: `/${prefix.replace(/^\/+|\/+$/g, "")}/`, dir: siteRoot(dir) };
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
  console.log(`Mindless Midi: http://localhost:${port}/  (serving ${root}${mounts.map((m) => `, ${m.prefix} from ${m.dir}`).join("")})`);
});
server.listen(port);
