// The only container of an OpenCode stack that holds keys.
//
// OpenCode runs its tools (bash, edit, write) in the process that talks to the
// model, so the sandbox must hold no secret. It sends every model call and
// every memory call here, with whatever placeholder key it needs; this gateway
// replaces the Authorization header with the real key, read from a Docker
// secret, and forwards the request:
//
//   /v1/…        → LITELLM_URL/v1/…     with the key of LITELLM_API_KEY_FILE
//   /mcp/<bank>/ → HINDSIGHT_URL/mcp/…  with the key of HINDSIGHT_API_KEY_FILE
//   /health      → 200 from the gateway itself
//
// Every other path is answered with 404, so the sandbox reaches nothing else
// through it. Responses stream through unchanged, server-sent events included.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";

// headers that describe one connection and must not be forwarded (RFC 9110 7.6.1)
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "authorization"
]);

export function readSecret(name, environment = process.env) {
  const path = environment[name];
  if (!path) return undefined;
  let value;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new Error(`${name} names ${path}, which cannot be read: ${error.code}`);
  }
  if (!value) throw new Error(`${name} names ${path}, which is empty`);
  return value;
}

export function upstreamUrl(name, fallback, environment = process.env) {
  const value = (environment[name] || fallback).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(value)) throw new Error(`${name} must be an http or https address, got: ${value}`);
  return value;
}

export function loadConfig(environment = process.env) {
  return {
    port: Number(environment.OPENCODE_GATEWAY_PORT || 8080),
    routes: [
      { prefix: "/v1/", target: upstreamUrl("LITELLM_URL", "http://litellm:4000", environment), key: readSecret("LITELLM_API_KEY_FILE", environment) },
      { prefix: "/mcp/", target: upstreamUrl("HINDSIGHT_URL", "http://hindsight:8888", environment), key: readSecret("HINDSIGHT_API_KEY_FILE", environment) }
    ]
  };
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function forwardHeaders(incoming, target, key) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
  }
  headers.host = new URL(target).host;
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

export function createGateway(config) {
  return createServer((request, response) => {
    const path = request.url || "/";
    if (path === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    // A dot segment, plain or percent-encoded, would let a request that
    // matched /mcp/ reach another path of the upstream once the URL is
    // resolved, with the key of this route; such a path is refused outright.
    const segments = path.split("?")[0].split("/").map((segment) => decodeSegment(segment));
    const route = segments.includes("..") || segments.includes(".")
      ? undefined
      : config.routes.find(({ prefix }) => path.startsWith(prefix));
    if (!route) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }
    const target = new URL(route.target + path);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(target, {
      method: request.method,
      headers: forwardHeaders(request.headers, route.target, route.key)
    }, (answer) => {
      const headers = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        headers[name] = value;
      }
      response.writeHead(answer.statusCode || 502, headers);
      answer.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "upstream unreachable", upstream: route.target, detail: error.code || error.message }));
    });
    request.pipe(upstream);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "--health") {
    const port = Number(process.env.OPENCODE_GATEWAY_PORT || 8080);
    fetch(`http://127.0.0.1:${port}/health`).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  } else {
    try {
      const config = loadConfig();
      createGateway(config).listen(config.port, "0.0.0.0", () => {
        console.log(`opencode gateway on port ${config.port}: ${config.routes.map((r) => `${r.prefix} → ${r.target}${r.key ? " with key" : ""}`).join(", ")}`);
      });
    } catch (error) {
      console.error(`opencode gateway: ${error.message}`);
      process.exit(1);
    }
  }
}
