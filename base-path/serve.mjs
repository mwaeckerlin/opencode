#!/usr/bin/env node
// Front process of the sandbox when OPENCODE_BASE_PATH is set: starts OpenCode
// on the loopback interface and serves it below the base path on OPENCODE_PORT.
//
// OpenCode is one compiled executable; no module can be loaded ahead of its
// server. This process takes the base path off every request and websocket
// upgrade below it, puts it in front of every root-absolute Location, answers
// the bare base path with a redirect to its slash form, and adjusts what the
// browser needs below the base path: the page loads the browser script first
// and names its files below the base path, the stylesheets name their fonts
// there, the web manifest names its icons relative to itself, and the bundle
// gives its router the base path (patch-upstream.mjs). Requests outside the
// base path reach OpenCode unchanged, for the health check and for the agents
// that address the server inside the stack.
//
//   serve.mjs [<opencode command>...]   default /usr/local/bin/opencode
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

import {
  ConfigurationError,
  SCRIPT_NAME,
  UPSTREAM_PORT,
  parseBasePath,
  parsePort,
  prefixLocation,
  rewriteCss,
  rewriteHtml,
  rewriteManifest,
  routeRequestUrl,
} from "./configuration.mjs";
import { PatchError, patchScript } from "./patch-upstream.mjs";

// OpenCode answered its first request after about two seconds in the image
// (measured 2026-10-27); the limit leaves room for a slow volume.
const START_TIMEOUT = 120000;

// headers that describe one connection and are not forwarded (RFC 9110 7.6.1)
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

const SCRIPT = fs.readFileSync(new URL(`./${SCRIPT_NAME}`, import.meta.url));

function pathOf(url) {
  const end = url.search(/[?#]/);
  return end < 0 ? url : url.slice(0, end);
}

// What the front process adjusts in an answer below the base path.
export function kindOf(url, contentType = "") {
  const type = String(contentType).toLowerCase();
  if (type.startsWith("text/html")) return "html";
  if (type.startsWith("text/css")) return "css";
  if (type.includes("javascript")) return "script";
  if (type.includes("manifest+json") || pathOf(url).endsWith(".webmanifest")) return "manifest";
  return undefined;
}

function transform(kind, url, text, basePath) {
  if (kind === "html") return rewriteHtml(text, basePath);
  if (kind === "css") return rewriteCss(text, basePath);
  if (kind === "script") return patchScript(pathOf(url), text);
  return rewriteManifest(text);
}

function decode(body, encoding = "identity") {
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(body);
  if (encoding === "deflate") return zlib.inflateSync(body);
  if (encoding === "br") return zlib.brotliDecompressSync(body);
  return body;
}

function forwardedHeaders(headers) {
  const copy = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) copy[name] = value;
  }
  return copy;
}

function answerHeaders(answer, inside, basePath) {
  const headers = forwardedHeaders(answer.headers);
  if (inside && headers.location !== undefined) headers.location = prefixLocation(headers.location, basePath);
  return headers;
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

export function createFrontServer({ basePath, host = "127.0.0.1", port = UPSTREAM_PORT }) {
  const upstream = `http://${host}:${port}`;

  function forward(request, response, route) {
    const inside = route.kind === "inside";
    const headers = forwardedHeaders(request.headers);
    // an answer the front process adjusts has to arrive as plain text
    if (inside) delete headers["accept-encoding"];
    const proxied = http.request({ host, port, method: request.method, path: route.url, headers }, (answer) => {
      const out = answerHeaders(answer, inside, basePath);
      const kind = inside && request.method !== "HEAD" && answer.statusCode === 200 ? kindOf(route.url, answer.headers["content-type"]) : undefined;
      if (!kind) {
        response.writeHead(answer.statusCode ?? 502, out);
        answer.pipe(response);
        return;
      }
      const chunks = [];
      answer.on("data", (chunk) => chunks.push(chunk));
      answer.on("error", (error) => response.destroy(error));
      answer.on("end", () => {
        let body;
        try {
          const text = decode(Buffer.concat(chunks), answer.headers["content-encoding"]).toString("utf8");
          body = Buffer.from(transform(kind, route.url, text, basePath), "utf8");
        } catch (error) {
          const detail = error instanceof PatchError ? error.message : `${pathOf(route.url)} could not be adjusted below ${basePath}: ${error.message}`;
          console.error(`opencode: ${detail}`);
          sendJson(response, 502, { error: "the interface of OpenCode cannot be served below the base path", detail });
          return;
        }
        delete out["content-encoding"];
        delete out["content-length"];
        out["content-length"] = body.length;
        response.writeHead(answer.statusCode, out);
        response.end(body);
      });
    });
    proxied.on("error", (error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      sendJson(response, 502, { error: "OpenCode does not answer", upstream, detail: error.code || error.message });
    });
    request.pipe(proxied);
  }

  const server = http.createServer((request, response) => {
    const route = routeRequestUrl(request.url, basePath);
    if (route.kind === "bare") {
      response.writeHead(308, { location: route.url, "content-length": "0" });
      response.end();
      return;
    }
    if (route.kind === "inside" && pathOf(route.url) === `/${SCRIPT_NAME}` && (request.method === "GET" || request.method === "HEAD")) {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-length": SCRIPT.length, "cache-control": "no-cache" });
      response.end(request.method === "HEAD" ? undefined : SCRIPT);
      return;
    }
    forward(request, response, route);
  });

  server.on("upgrade", (request, socket, head) => {
    const route = routeRequestUrl(request.url, basePath);
    if (route.kind === "bare") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const inside = route.kind === "inside";
    const proxied = http.request({ host, port, method: request.method, path: route.url, headers: request.headers });
    const lines = (answer, drop) => {
      let text = "";
      for (let index = 0; index < answer.rawHeaders.length; index += 2) {
        const name = answer.rawHeaders[index];
        let value = answer.rawHeaders[index + 1];
        if (drop.has(name.toLowerCase())) continue;
        if (inside && name.toLowerCase() === "location") value = prefixLocation(value, basePath);
        text += `${name}: ${value}\r\n`;
      }
      return text;
    };
    proxied.on("upgrade", (answer, upstreamSocket, upstreamHead) => {
      socket.write(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n${lines(answer, new Set())}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    // OpenCode refused the upgrade: its answer goes back as it is, and the
    // connection ends with the body
    proxied.on("response", (answer) => {
      socket.write(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n${lines(answer, HOP_BY_HOP)}Connection: close\r\n\r\n`);
      answer.pipe(socket);
    });
    proxied.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    socket.on("error", () => proxied.destroy());
    proxied.end();
  });

  return server;
}

async function answers(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  return response !== undefined;
}

async function main() {
  let basePath;
  let port;
  try {
    basePath = parseBasePath(process.env.OPENCODE_BASE_PATH);
    port = parsePort(process.env.OPENCODE_PORT);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    console.error(`opencode: configuration error: ${error.message}`);
    process.exit(1);
  }

  const [command, ...prefix] = process.argv.length > 2 ? process.argv.slice(2) : ["/usr/local/bin/opencode"];
  const listen = basePath ? ["--hostname", "127.0.0.1", "--port", String(UPSTREAM_PORT)] : ["--hostname", "0.0.0.0", "--port", String(port)];
  const child = spawn(command, [...prefix, "web", ...listen], { stdio: "inherit" });
  let server;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`opencode: ${command} cannot be started: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    server?.close();
    process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0));
  });
  if (!basePath) return;

  const deadline = Date.now() + START_TIMEOUT;
  while (!(await answers(`http://127.0.0.1:${UPSTREAM_PORT}/global/health`))) {
    if (Date.now() > deadline) {
      console.error(`opencode: OpenCode did not answer on 127.0.0.1:${UPSTREAM_PORT} within ${START_TIMEOUT / 1000}s`);
      child.kill("SIGTERM");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server = createFrontServer({ basePath });
  server.on("error", (error) => {
    console.error(`opencode: port ${port} cannot be opened: ${error.message}`);
    child.kill("SIGTERM");
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => console.log(`opencode: serving below ${basePath}/ on port ${port}`));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
