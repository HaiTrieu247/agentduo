// Serves dist/ as a static host would: a directory route ends with "/", a missing path answers 404 with the
// language's 404 page, and nothing outside dist/ can be read. For looking at a build, not for production.
//
//   node scripts/preview.mjs [--port 4173] [--dir dist]
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

/** The 404 page for a path: the language's own under its prefix (/vi/…), else the default one. */
function notFoundPage(root, pathname) {
  const m = /^\/([a-z]{2})\//.exec(pathname);
  const local = m ? join(root, m[1], "404.html") : null;
  return local && existsSync(local) ? local : join(root, "404.html");
}

/** A request handler serving `dir`. */
export function handler(dir) {
  const root = realpathSync(resolve(dir));
  return (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://preview.invalid").pathname);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const send = (file, status) => {
      res.writeHead(status, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).pipe(res);
    };
    const missing = () => send(notFoundPage(root, pathname), 404);
    if (pathname.includes("\0")) return missing();
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) return missing();
    if (!existsSync(file)) return missing();
    let real;
    try {
      real = realpathSync(file);
    } catch {
      return missing();
    }
    if (real !== root && !real.startsWith(root + sep)) return missing();
    if (statSync(real).isDirectory()) {
      if (!pathname.endsWith("/")) {
        const url = new URL(req.url, "http://preview.invalid");
        res.writeHead(301, { Location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      file = join(real, "index.html");
      if (!existsSync(file)) return missing();
      return send(file, 200);
    }
    send(real, 200);
  };
}

export function startPreview({ dir, port = 4173, host = "127.0.0.1" } = {}) {
  const server = createServer(handler(dir));
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => done(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  const dir = opt("--dir", join(fileURLToPath(new URL("..", import.meta.url)), "dist"));
  if (!existsSync(join(dir, "index.html"))) {
    console.error(`no build in ${dir}: run npm run build first`);
    process.exit(1);
  }
  const port = Number(opt("--port", process.env.PORT ?? 4173));
  const server = await startPreview({ dir, port });
  const { port: actual } = server.address();
  console.log(`serving ${dir} at http://127.0.0.1:${actual}/ (Ctrl+C to stop)`);
}
