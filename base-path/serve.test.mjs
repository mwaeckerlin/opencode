// Tests of base-path/serve.mjs against real HTTP servers of node standing in
// for OpenCode: requests, answers and websocket upgrades below the base path,
// the bare base path, the root, and the start of the front process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { UPSTREAM_PORT } from "./configuration.mjs";
import { createFrontServer, kindOf } from "./serve.mjs";

const SERVE = fileURLToPath(new URL("./serve.mjs", import.meta.url));
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const PAGE = fixture("index.html");
const ROUTER = fixture("router.js");
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'";

// OpenCode as the front process sees it: the page for every unknown path, the
// bundle, a stylesheet, the manifest, JSON with the path it saw, redirects, an
// event stream, and websocket upgrades that echo or refuse.
function opencode(request, response) {
  const url = request.url;
  if (url === "/assets/index-BVEDUzgq.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(ROUTER);
  } else if (url === "/assets/twice.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(ROUTER + ROUTER);
  } else if (url === "/assets/index-DLiUNAg_.css") {
    const body = zlib.gzipSync("@font-face{src:url(/assets/Inter.ttf)}");
    response.writeHead(200, { "content-type": "text/css", "content-encoding": "gzip", "content-length": body.length });
    response.end(body);
  } else if (url === "/site.webmanifest") {
    response.writeHead(200, { "content-type": "application/manifest+json" });
    response.end(fixture("site.webmanifest"));
  } else if (url === "/redirect") {
    response.writeHead(302, { location: "/session?x=1" });
    response.end();
  } else if (url === "/redirect-away") {
    response.writeHead(302, { location: "https://opencode.ai/auth" });
    response.end();
  } else if (url === "/global/event") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  } else if (url.startsWith("/global/") || url.startsWith("/session")) {
    response.writeHead(200, { "content-type": "application/json", "x-encoding": request.headers["accept-encoding"] ?? "none" });
    response.end(JSON.stringify({ url, method: request.method, authorization: request.headers.authorization ?? null }));
  } else {
    response.writeHead(200, { "content-type": "text/html", "content-security-policy": CSP });
    response.end(PAGE);
  }
}

async function stack(t, basePath = "/opencode") {
  const upstream = http.createServer(opencode);
  upstream.on("upgrade", (request, socket) => {
    if (request.url.startsWith("/pty/")) {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Path: ${request.url}\r\n\r\n`);
      socket.on("data", (chunk) => socket.write(`echo ${chunk}`));
      socket.on("end", () => socket.end());
    } else {
      socket.end("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Secure Area\"\r\nContent-Length: 4\r\n\r\nnope");
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const front = createFrontServer({ basePath, port: upstream.address().port });
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    front.closeAllConnections();
    upstream.closeAllConnections();
    front.close();
    upstream.close();
  });
  return { url: `http://127.0.0.1:${front.address().port}`, port: front.address().port };
}

function upgrade(port, path, send) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    });
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk;
      if (send && answer.includes("\r\n\r\n") && !answer.includes("echo")) socket.write(send);
      if (answer.includes("echo")) socket.end();
    });
    socket.on("end", () => resolve(answer));
    socket.on("close", () => resolve(answer));
    socket.on("error", reject);
  });
}

test("below the base path OpenCode sees the path of its own routes, outside it sees the path as it is", async (t) => {
  const { url } = await stack(t);
  assert.equal((await (await fetch(`${url}/opencode/global/health?x=1`)).json()).url, "/global/health?x=1");
  const post = await fetch(`${url}/opencode/session`, { method: "POST", body: "{}", headers: { authorization: "Basic b3BlbmNvZGU6cHc=" } });
  assert.deepEqual(await post.json(), { url: "/session", method: "POST", authorization: "Basic b3BlbmNvZGU6cHc=" });
  // the agents of the stack address the server at the root
  assert.equal((await (await fetch(`${url}/session`)).json()).url, "/session");
  assert.equal((await (await fetch(`${url}/global/opencodex`)).json()).url, "/global/opencodex");
});

test("the bare base path redirects to its slash form, with the query", async (t) => {
  const { url } = await stack(t);
  for (const [request, location] of [["/opencode", "/opencode/"], ["/opencode?x=%2F", "/opencode/?x=%2F"]]) {
    const response = await fetch(url + request, { redirect: "manual" });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), location);
  }
  assert.equal((await fetch(`${url}/opencode`, { method: "POST", body: "x", redirect: "manual" })).status, 308);
});

test("a root-absolute redirect below the base path keeps the base path, a foreign one and one at the root stay", async (t) => {
  const { url } = await stack(t);
  const location = async (request) => (await fetch(url + request, { redirect: "manual" })).headers.get("location");
  assert.equal(await location("/opencode/redirect"), "/opencode/session?x=1");
  assert.equal(await location("/opencode/redirect-away"), "https://opencode.ai/auth");
  assert.equal(await location("/redirect"), "/session?x=1");
});

test("the page below the base path loads the browser script first and keeps its security policy", async (t) => {
  const { url } = await stack(t);
  for (const path of ["/opencode/", "/opencode/L3dvcmtzcGFjZQ/session"]) {
    const response = await fetch(url + path);
    assert.equal(response.headers.get("content-security-policy"), CSP);
    const html = await response.text();
    assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(html));
    assert.match(html, /<head>\n<script src="\/opencode\/opencode-base-path.js"><\/script>/);
    assert.match(html, /src="\/opencode\/assets\/index-BVEDUzgq.js"/);
    assert.match(html, /href="\/opencode\/assets\/index-DLiUNAg_.css"/);
  }
  // at the root the page is the one of OpenCode
  assert.equal(await (await fetch(`${url}/`)).text(), PAGE);
});

test("the browser script is served below the base path", async (t) => {
  const { url } = await stack(t);
  const response = await fetch(`${url}/opencode/opencode-base-path.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/javascript/);
  assert.equal(await response.text(), fs.readFileSync(new URL("./opencode-base-path.js", import.meta.url), "utf8"));
});

test("the bundle gives its router the base path, the stylesheet its fonts and the manifest its icons", async (t) => {
  const { url } = await stack(t);
  assert.match(await (await fetch(`${url}/opencode/assets/index-BVEDUzgq.js`)).text(), /const\{base:n=globalThis\.__opencodeBasePath\}=t/);
  const css = await fetch(`${url}/opencode/assets/index-DLiUNAg_.css`);
  assert.equal(css.headers.get("content-encoding"), null);
  assert.equal(await css.text(), "@font-face{src:url(/opencode/assets/Inter.ttf)}");
  assert.deepEqual((await (await fetch(`${url}/opencode/site.webmanifest`)).json()).icons.map((icon) => icon.src),
    ["./web-app-manifest-192x192.png", "./web-app-manifest-512x512.png"]);
  // the root serves the bundle of OpenCode unchanged
  assert.equal(await (await fetch(`${url}/assets/index-BVEDUzgq.js`)).text(), ROUTER);
});

test("below the base path OpenCode is asked for plain text, at the root the client decides", async (t) => {
  const { url } = await stack(t);
  const below = await fetch(`${url}/opencode/global/health`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(below.headers.get("x-encoding"), "none");
  const root = await fetch(`${url}/global/health`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(root.headers.get("x-encoding"), "gzip");
});

test("a bundle with the router code twice answers 502 and names file and text", async (t) => {
  const { url } = await stack(t);
  const response = await fetch(`${url}/opencode/assets/twice.js`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).detail, /\/assets\/twice.js carries the router factory of Solid Router 2 times instead of once/);
});

test("the event stream arrives while it is open", async (t) => {
  const { url } = await stack(t);
  const controller = new AbortController();
  const response = await fetch(`${url}/opencode/global/event`, { signal: controller.signal });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.equal(Buffer.from(value).toString(), "data: first\n\n");
  controller.abort();
});

test("a websocket below the base path reaches OpenCode with the path of its routes and carries data both ways", { timeout: 10000 }, async (t) => {
  const { port } = await stack(t);
  const below = await upgrade(port, "/opencode/pty/abc/connect?ticket=1", "hello");
  assert.match(below, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(below, /X-Path: \/pty\/abc\/connect\?ticket=1\r\n/);
  assert.match(below, /echo hello/);
  assert.match(await upgrade(port, "/pty/abc/connect", "hello"), /X-Path: \/pty\/abc\/connect\r\n/);
  // a refused upgrade comes back as OpenCode wrote it, the bare base path has none
  const refused = await upgrade(port, "/opencode/global/x");
  assert.match(refused, /^HTTP\/1\.1 401 Unauthorized\r\n/);
  assert.match(refused, /WWW-Authenticate: Basic realm="Secure Area"\r\n/);
  assert.match(refused, /nope$/);
  assert.match(await upgrade(port, "/opencode"), /^HTTP\/1\.1 404 Not Found\r\n/);
});

test("an OpenCode that does not answer gives 502 with its address", async (t) => {
  const server = createFrontServer({ basePath: "/opencode", port: 1 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/opencode/`);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "OpenCode does not answer", upstream: "http://127.0.0.1:1", detail: "ECONNREFUSED" });
});

test("only page, stylesheet, script and manifest are adjusted", () => {
  assert.equal(kindOf("/", "text/html; charset=utf-8"), "html");
  assert.equal(kindOf("/assets/x.css", "text/css"), "css");
  assert.equal(kindOf("/assets/x.js", "application/javascript"), "script");
  assert.equal(kindOf("/assets/x.js", "text/javascript;charset=utf-8"), "script");
  assert.equal(kindOf("/site.webmanifest", "application/manifest+json"), "manifest");
  assert.equal(kindOf("/site.webmanifest", "application/octet-stream"), "manifest");
  assert.equal(kindOf("/global/event", "text/event-stream"), undefined);
  assert.equal(kindOf("/session", "application/json"), undefined);
  assert.equal(kindOf("/assets/x.png", "image/png"), undefined);
});

// OpenCode for the start of the front process: it answers on the port it is
// given, with the arguments it got.
const FAKE = `
import http from "node:http";
const args = process.argv.slice(1);
const port = Number(args[args.indexOf("--port") + 1]);
const host = args[args.indexOf("--hostname") + 1];
http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ url: request.url, args }));
}).listen(port, host);
process.on("SIGTERM", () => process.exit(0));
`;

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startFront(env) {
  const child = spawn(process.execPath, [SERVE, process.execPath, "--input-type=module", "-e", FAKE, "--"], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve({ code, output })));
  return { child, exit, output: () => output };
}

async function until(check, what) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check().catch(() => undefined);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} within 15s`);
}

test("the front process starts OpenCode behind it and serves it below the base path", async (t) => {
  const port = await freePort();
  const front = startFront({ OPENCODE_BASE_PATH: "/opencode", OPENCODE_PORT: String(port) });
  t.after(() => front.child.kill("SIGTERM"));
  const answer = await until(async () => (await fetch(`http://127.0.0.1:${port}/opencode/session`)).json(), "no answer below the base path");
  assert.equal(answer.url, "/session");
  assert.deepEqual(answer.args.slice(-5), ["web", "--hostname", "127.0.0.1", "--port", String(UPSTREAM_PORT)]);
  assert.match(front.output(), new RegExp(`opencode: serving below /opencode/ on port ${port}`));
  // a stop of the container stops OpenCode and the front process
  front.child.kill("SIGTERM");
  assert.equal((await front.exit).code, 0);
});

test("with / as base path OpenCode itself listens on the port, at the root", async (t) => {
  const port = await freePort();
  const front = startFront({ OPENCODE_BASE_PATH: "/", OPENCODE_PORT: String(port) });
  t.after(() => front.child.kill("SIGTERM"));
  const answer = await until(async () => (await fetch(`http://127.0.0.1:${port}/session`)).json(), "no answer at the root");
  assert.deepEqual(answer.args.slice(-5), ["web", "--hostname", "0.0.0.0", "--port", String(port)]);
  assert.doesNotMatch(front.output(), /serving below/);
});

test("a wrong setting stops the start with a message that names it", async () => {
  for (const [env, message] of [
    [{ OPENCODE_BASE_PATH: "opencode" }, /opencode: configuration error: OPENCODE_BASE_PATH is "opencode"; it must be a path such as \/opencode/],
    [{ OPENCODE_BASE_PATH: "/open code" }, /OPENCODE_BASE_PATH is "\/open code"/],
    [{ OPENCODE_BASE_PATH: "/x/../y" }, /OPENCODE_BASE_PATH is "\/x\/..\/y"/],
    [{ OPENCODE_BASE_PATH: "/opencode", OPENCODE_PORT: String(UPSTREAM_PORT) }, /OPENCODE_PORT is 14096, the port OpenCode itself listens on/],
  ]) {
    const { code, output } = await startFront(env).exit;
    assert.equal(code, 1, output);
    assert.match(output, message);
  }
});
