// Local Test server for the Twitch Developer Console.
//
// Serves dist/frontend at https://localhost:8080/ (the console's default "Testing
// Base URI") and proxies https://localhost:8080/ebs/* to the EBS on http://127.0.0.1:8081,
// so the panel, config page and EBS share one HTTPS origin and one certificate.
//
//   node scripts/dev-frontend.ts
//
// First run creates a self-signed certificate in .venv/certs. Open
// https://localhost:8080/panel.html once in the browser and accept it, otherwise the
// Twitch iframe can't load the page.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { SignJWT } from "jose";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist/frontend");
const CERTS = join(ROOT, ".venv/certs");
const PORT = Number(process.env.DEV_PORT || 8080);
const EBS_PORT = Number(process.env.PORT || 8081);

if (!existsSync(join(CERTS, "localhost.crt"))) {
  mkdirSync(CERTS, { recursive: true });
  const r = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", join(CERTS, "localhost.key"), "-out", join(CERTS, "localhost.crt")],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("openssl failed to create a dev certificate");
}

const build = spawnSync(process.execPath, [join(ROOT, "scripts/build-frontend.ts")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = createServer(
  { key: readFileSync(join(CERTS, "localhost.key")), cert: readFileSync(join(CERTS, "localhost.crt")) },
  (req, res) => {
    const url = new URL(req.url ?? "/", "https://localhost");

    if (url.pathname.startsWith("/ebs/")) {
      const upstream = httpRequest(
        { host: "127.0.0.1", port: EBS_PORT, method: req.method, path: url.pathname.slice(4) + url.search, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `EBS not reachable on 127.0.0.1:${EBS_PORT} (npm run dev)` }));
      });
      req.pipe(upstream);
      return;
    }

    if (url.pathname.startsWith("/harness/")) return harness(url, res);

    const file = normalize(join(DIST, url.pathname === "/" ? "panel.html" : url.pathname));
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  },
);

// --- DEV-ONLY harness: run the real pages outside Twitch with a fake helper. ---
// Never part of the uploaded zip (lives in scripts/, served only by this dev server).
async function harness(url: URL, res: import("node:http").ServerResponse): Promise<void> {
  const page = url.pathname.slice("/harness/".length);
  if (page === "token") {
    const secretB64 = process.env.TWITCH_EXT_SECRET;
    if (!secretB64) {
      res.writeHead(500).end("TWITCH_EXT_SECRET not set (start with --env-file=.env)");
      return;
    }
    const channel = /^\d+$/.test(url.searchParams.get("channel") ?? "") ? url.searchParams.get("channel")! : "23523234";
    const role = url.searchParams.get("role") === "broadcaster" ? "broadcaster" : "viewer";
    const token = await new SignJWT({
      channel_id: channel,
      opaque_user_id: role === "broadcaster" ? "U" + channel : "Aharness",
      role,
      ...(role === "broadcaster" ? { user_id: channel } : {}),
      pubsub_perms: { listen: ["broadcast", "global"] },
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new Uint8Array(Buffer.from(secretB64, "base64")));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token }));
    return;
  }
  if (page === "fake-twitch-ext.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    res.end(readFileSync(join(ROOT, "scripts/harness/fake-twitch-ext.js")));
    return;
  }
  if (page === "panel.html" || page === "config.html") {
    const html = readFileSync(join(DIST, page), "utf8")
      .replace("https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js", "/harness/fake-twitch-ext.js")
      .replace("<head>", '<head>\n    <base href="/" />');
    res.writeHead(200, { "content-type": TYPES[".html"]!, "cache-control": "no-store" }).end(html);
    return;
  }
  res.writeHead(404).end("not found");
}

server.listen(PORT, () => {
  console.log(`Local Test server: https://localhost:${PORT}/  (panel.html, config.html; /ebs -> 127.0.0.1:${EBS_PORT})`);
});
