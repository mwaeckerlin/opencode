#!/usr/bin/env node
// Front process of the sandbox when OPENCODE_BASE_PATH,
// LITELLM_SUBSCRIPTION_LOGIN_URL or OPENCODE_ALERT_TOKEN_SHA256 is set: starts
// OpenCode on the loopback interface and serves it on OPENCODE_PORT.
//
// OpenCode is one compiled executable; no module can be loaded ahead of its
// server. Below a base path, this process takes the base path off every
// request and websocket upgrade below it, puts it in front of every
// root-absolute Location, answers the bare base path with a redirect to its
// slash form, and adjusts what the browser needs below the base path: the page
// loads the browser script first and names its files below the base path, the
// stylesheets name their fonts there, the web manifest names its icons
// relative to itself, and the bundle gives its router the base path
// (patch-upstream.mjs). Requests outside the base path reach OpenCode
// unchanged, for the health check and for the agents that address the server
// inside the stack.
//
// With a login address, the page carries a link to the login page of the
// LiteLLM subscriptions. With the digest of an alert token, POST /alert puts
// the body of a Grafana or Alertmanager webhook into a fixed session of
// OpenCode, without an answer of the model.
//
//   serve.mjs [<opencode command>...]   default /usr/local/bin/opencode
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

import {
  ALERT_PATH,
  ConfigurationError,
  LOGIN_STYLE_NAME,
  SCRIPT_NAME,
  UPSTREAM_PORT,
  alertText,
  parseBasePath,
  parseByteLimit,
  parseLoginUrl,
  parsePort,
  parseSessionTitle,
  parseTokenDigest,
  prefixLocation,
  rewriteCss,
  rewriteHtml,
  rewriteManifest,
  routeRequestUrl,
  tokenMatches,
} from "./configuration.mjs";
import { PatchError, patchScript } from "./patch-upstream.mjs";

// OpenCode answered its first request after about two seconds in the image
// (measured 2026-10-27); the limit leaves room for a slow volume.
const START_TIMEOUT = 120000;

// headers that describe one connection and are not forwarded (RFC 9110 7.6.1)
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

const SCRIPT = fs.readFileSync(new URL(`./${SCRIPT_NAME}`, import.meta.url));
const LOGIN_STYLE = fs.readFileSync(new URL(`./${LOGIN_STYLE_NAME}`, import.meta.url));

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

function transform(kind, url, text, basePath, loginUrl) {
  if (kind === "html") return rewriteHtml(text, basePath, loginUrl);
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

// The basic authentication of OpenCode's server, for the calls of the front
// process itself; empty where the server has no password.
function serverAuthorization(password = process.env.OPENCODE_SERVER_PASSWORD) {
  return password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : "";
}

// A JSON call of the front process to OpenCode.
function call({ host, port, authorization }, method, path, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers = { accept: "application/json" };
    if (body !== undefined) Object.assign(headers, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    if (authorization) headers.authorization = authorization;
    const request = http.request({ host, port, method, path, headers, timeout: 30000 }, (answer) => {
      const chunks = [];
      answer.on("data", (chunk) => chunks.push(chunk));
      answer.on("error", reject);
      answer.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = raw ? JSON.parse(raw) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status: answer.statusCode, json, raw });
      });
    });
    request.on("timeout", () => request.destroy(new Error(`${method} ${path} got no answer within 30s`)));
    request.on("error", reject);
    request.end(text);
  });
}

export class AlertError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// The session that collects the alerts: found again by its title among the
// sessions of OpenCode, created where none carries it.
export function alertSession({ host = "127.0.0.1", port = UPSTREAM_PORT, title = "Alerts", authorization = serverAuthorization() } = {}) {
  const target = { host, port, authorization };
  let pending;
  const unreachable = (error) => new AlertError(502, "OpenCode does not answer", error.code || error.message);
  async function find() {
    const listed = await call(target, "GET", "/session").catch((error) => {
      throw unreachable(error);
    });
    if (listed.status !== 200 || !Array.isArray(listed.json)) {
      throw new AlertError(502, "OpenCode did not list its sessions", `GET /session answered ${listed.status}: ${listed.raw.slice(0, 200)}`);
    }
    const own = listed.json
      .filter((session) => session?.title === title && !session.parentID)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
    if (own) return own.id;
    const created = await call(target, "POST", "/session", { title }).catch((error) => {
      throw unreachable(error);
    });
    if (created.status !== 200 || typeof created.json?.id !== "string") {
      throw new AlertError(502, "OpenCode did not create the alert session", `POST /session answered ${created.status}: ${created.raw.slice(0, 200)}`);
    }
    return created.json.id;
  }
  async function post(sessionID, text) {
    return call(target, "POST", `/session/${encodeURIComponent(sessionID)}/message`, { noReply: true, parts: [{ type: "text", text }] }).catch((error) => {
      throw unreachable(error);
    });
  }
  return {
    title,
    // one search at a time, so two alerts at the start create one session
    id() {
      pending ??= find().catch((error) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
    // a session deleted in the web interface is found or created anew, once
    async post(text) {
      let sessionID = await this.id();
      let answer = await post(sessionID, text);
      if (answer.status === 404) {
        pending = undefined;
        sessionID = await this.id();
        answer = await post(sessionID, text);
      }
      if (answer.status !== 200) {
        throw new AlertError(502, "OpenCode did not take the alert", `POST /session/${sessionID}/message answered ${answer.status}: ${answer.raw.slice(0, 200)}`);
      }
      return { session: sessionID, message: answer.json?.info?.id ?? null };
    },
  };
}

// Reads a request body up to a limit; a larger one stops with 413.
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new AlertError(413, `the alert is larger than ${limit} bytes`, `content-length ${declared}`));
      request.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    const collect = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // the rest is read and dropped, so the answer reaches the sender
        request.off("data", collect);
        request.resume();
        reject(new AlertError(413, `the alert is larger than ${limit} bytes`, `more than ${limit} bytes arrived`));
        return;
      }
      chunks.push(chunk);
    };
    request.on("data", collect);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function relayAlert(request, response, { alerts, loginUrl }) {
  if (request.method !== "POST" && request.method !== "PUT") {
    response.writeHead(405, { allow: "POST, PUT", "content-type": "application/json" });
    response.end(JSON.stringify({ error: "an alert is sent with POST or PUT" }));
    return;
  }
  if (!tokenMatches(request.headers.authorization, alerts.digest)) {
    request.resume();
    response.writeHead(401, { "www-authenticate": 'Bearer realm="opencode-alerts"', "content-type": "application/json" });
    response.end(JSON.stringify({ error: "the alert needs the alert token as Authorization: Bearer <token>" }));
    return;
  }
  try {
    const body = await readBody(request, alerts.maxBytes);
    const text = alertText(body, request.headers["content-type"], loginUrl);
    if (!text) throw new AlertError(400, "the alert is empty", "the body carries no text");
    sendJson(response, 200, await alerts.session.post(text));
  } catch (error) {
    if (!(error instanceof AlertError)) throw error;
    if (error.status >= 500) console.error(`opencode: alert not delivered: ${error.message}: ${error.detail}`);
    if (!response.headersSent) sendJson(response, error.status, { error: error.message, detail: error.detail });
  }
}

// basePath "" serves at the root; loginUrl "" shows no link; alerts, where
// given, is { digest, maxBytes, session } and switches the alert relay on.
export function createFrontServer({ basePath, loginUrl = "", alerts, host = "127.0.0.1", port = UPSTREAM_PORT }) {
  const upstream = `http://${host}:${port}`;

  function forward(request, response, route) {
    const inside = route.kind === "inside";
    // at the root, a page the browser asks for carries the login link
    const page = !basePath && loginUrl && /text\/html/i.test(request.headers.accept ?? "");
    const headers = forwardedHeaders(request.headers);
    // an answer the front process adjusts has to arrive as plain text
    if (inside || page) delete headers["accept-encoding"];
    const proxied = http.request({ host, port, method: request.method, path: route.url, headers }, (answer) => {
      const out = answerHeaders(answer, inside, basePath);
      const adjusted = request.method !== "HEAD" && answer.statusCode === 200;
      const found = adjusted && (inside || page) ? kindOf(route.url, answer.headers["content-type"]) : undefined;
      const kind = inside || found === "html" ? found : undefined;
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
          body = Buffer.from(transform(kind, route.url, text, basePath, loginUrl), "utf8");
        } catch (error) {
          const detail = error instanceof PatchError ? error.message : `${pathOf(route.url)} could not be adjusted below ${basePath || "/"}: ${error.message}`;
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

  function serveFile(request, response, type, content) {
    response.writeHead(200, { "content-type": `${type}; charset=utf-8`, "content-length": content.length, "cache-control": "no-cache" });
    response.end(request.method === "HEAD" ? undefined : content);
  }

  const server = http.createServer((request, response) => {
    const route = routeRequestUrl(request.url, basePath);
    if (route.kind === "bare") {
      response.writeHead(308, { location: route.url, "content-length": "0" });
      response.end();
      return;
    }
    // the path of the request where the page lies: below the base path, or
    // anywhere without one
    const local = route.kind === "inside" || !basePath ? pathOf(route.url) : undefined;
    const read = request.method === "GET" || request.method === "HEAD";
    if (alerts && (local ?? pathOf(request.url)) === ALERT_PATH) {
      relayAlert(request, response, { alerts, loginUrl }).catch((error) => {
        console.error(`opencode: alert failed: ${error.stack ?? error}`);
        if (!response.headersSent) sendJson(response, 500, { error: "the alert could not be relayed", detail: error.message });
      });
      return;
    }
    if (basePath && local === `/${SCRIPT_NAME}` && read) {
      serveFile(request, response, "text/javascript", SCRIPT);
      return;
    }
    if (loginUrl && local === `/${LOGIN_STYLE_NAME}` && read) {
      serveFile(request, response, "text/css", LOGIN_STYLE);
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
  let loginUrl;
  let digest;
  let maxBytes;
  let title;
  try {
    basePath = parseBasePath(process.env.OPENCODE_BASE_PATH);
    port = parsePort(process.env.OPENCODE_PORT);
    loginUrl = parseLoginUrl(process.env.LITELLM_SUBSCRIPTION_LOGIN_URL);
    digest = parseTokenDigest(process.env.OPENCODE_ALERT_TOKEN_SHA256);
    maxBytes = parseByteLimit(process.env.OPENCODE_ALERT_MAX_BYTES);
    title = parseSessionTitle(process.env.OPENCODE_ALERT_SESSION_TITLE);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    console.error(`opencode: configuration error: ${error.message}`);
    process.exit(1);
  }

  const front = Boolean(basePath || loginUrl || digest);
  const [command, ...prefix] = process.argv.length > 2 ? process.argv.slice(2) : ["/usr/local/bin/opencode"];
  const listen = front ? ["--hostname", "127.0.0.1", "--port", String(UPSTREAM_PORT)] : ["--hostname", "0.0.0.0", "--port", String(port)];
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
  if (!front) return;

  const deadline = Date.now() + START_TIMEOUT;
  while (!(await answers(`http://127.0.0.1:${UPSTREAM_PORT}/global/health`))) {
    if (Date.now() > deadline) {
      console.error(`opencode: OpenCode did not answer on 127.0.0.1:${UPSTREAM_PORT} within ${START_TIMEOUT / 1000}s`);
      child.kill("SIGTERM");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const alerts = digest ? { digest, maxBytes, session: alertSession({ title }) } : undefined;
  server = createFrontServer({ basePath, loginUrl, alerts });
  server.on("error", (error) => {
    console.error(`opencode: port ${port} cannot be opened: ${error.message}`);
    child.kill("SIGTERM");
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(basePath ? `opencode: serving below ${basePath}/ on port ${port}` : `opencode: serving at the root on port ${port}`);
    if (loginUrl) console.log(`opencode: the web interface links to the subscription login ${loginUrl}`);
  });
  if (alerts) await prepareAlertSession(alerts.session, `${basePath}${ALERT_PATH}`);
}

// The alert session exists from the start. OpenCode answers its health check
// before its first session request, which loads the project and its plugins
// and took longer than the 30s of one call in the end-to-end stack; so the
// search repeats until OpenCode answers, after the delays of ALERT_RETRY_DELAYS
// and then every minute. An alert in between waits for the same search.
export const ALERT_RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000];

export async function prepareAlertSession(session, path, delays = ALERT_RETRY_DELAYS, last = 60000) {
  for (let attempt = 0; ; attempt++) {
    try {
      const id = await session.id();
      console.log(`opencode: alerts on ${path} go to the session ${id} «${session.title}»`);
      return id;
    } catch (error) {
      const wait = delays[attempt] ?? last;
      console.error(`opencode: the alert session «${session.title}» is not ready, next try in ${wait / 1000}s: ${error.message}: ${error.detail ?? ""}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
