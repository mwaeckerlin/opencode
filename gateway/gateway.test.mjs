// The gateway against real HTTP servers standing in for LiteLLM and Hindsight:
// it replaces the key, forwards path, body and stream, and refuses the rest.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, loadConfig, readSecret, upstreamUrl } from "./gateway.mjs";

const directory = mkdtempSync(join(tmpdir(), "opencode-gateway-"));
const secret = (name, value) => {
  const path = join(directory, name);
  writeFileSync(path, value);
  return path;
};

// an upstream that answers with what it received
const echo = () => new Promise((resolve) => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url.endsWith("/stream")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: one\n\n");
        setTimeout(() => response.end("data: two\n\n"), 50);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ method: request.method, url: request.url, authorization: request.headers.authorization, host: request.headers.host, body }));
    });
  });
  server.listen(0, "127.0.0.1", () => resolve(server));
});

const litellm = await echo();
const hindsight = await echo();
const address = (server) => `http://127.0.0.1:${server.address().port}`;
const environment = {
  LITELLM_URL: address(litellm),
  HINDSIGHT_URL: address(hindsight) + "/",
  LITELLM_API_KEY_FILE: secret("litellm", "real-litellm-key\n"),
  HINDSIGHT_API_KEY_FILE: secret("hindsight", "real-hindsight-key")
};
const gateway = createGateway(loadConfig(environment));
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const url = address(gateway);
after(() => { gateway.close(); litellm.close(); hindsight.close(); });

test("model call reaches LiteLLM with the real key instead of the placeholder", async () => {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer placeholder", "content-type": "application/json" },
    body: '{"model":"m"}'
  });
  const seen = await response.json();
  assert.equal(response.status, 200);
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.method, "POST");
  assert.equal(seen.body, '{"model":"m"}');
  assert.equal(seen.authorization, "Bearer real-litellm-key");
  assert.equal(seen.host, new URL(environment.LITELLM_URL).host);
});

test("memory call reaches Hindsight with the Hindsight key", async () => {
  const seen = await (await fetch(`${url}/mcp/shared/`, { method: "POST", body: "{}" })).json();
  assert.equal(seen.url, "/mcp/shared/");
  assert.equal(seen.authorization, "Bearer real-hindsight-key");
});

test("the LiteLLM key never reaches Hindsight and the other way round", async () => {
  const toHindsight = await (await fetch(`${url}/mcp/own/`, { method: "POST", body: "{}" })).json();
  const toLitellm = await (await fetch(`${url}/v1/models`)).json();
  assert.notEqual(toHindsight.authorization, "Bearer real-litellm-key");
  assert.notEqual(toLitellm.authorization, "Bearer real-hindsight-key");
});

test("a stream arrives as a stream", async () => {
  const response = await fetch(`${url}/v1/stream`);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), "data: one\n\ndata: two\n\n");
});

test("every other path is refused", async () => {
  for (const path of ["/", "/admin", "/v2/x", "/mcpx", "/v1", "/mcp"]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 404, path);
  }
});

// a raw request line, which fetch would normalise before sending
const raw = (path) => new Promise((resolve, reject) => {
  const call = httpRequest({ host: "127.0.0.1", port: new URL(url).port, path, method: "GET" }, (response) => {
    response.resume();
    resolve(response.statusCode);
  });
  call.on("error", reject);
  call.end();
});

test("a dot segment cannot leave the route it came in on", async () => {
  for (const path of ["/mcp/../v1/default/banks", "/mcp/shared/../../v1/models", "/v1/../mcp/x/", "/mcp/%2e%2e/v1/default/banks", "/v1/%2E%2E/admin"]) {
    assert.equal(await raw(path), 404, path);
  }
});

test("health answers from the gateway itself", async () => {
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
});

test("an unreachable upstream answers 502 and names it", async () => {
  const broken = createGateway({ port: 0, routes: [{ prefix: "/v1/", target: "http://127.0.0.1:9", key: "k" }] });
  await new Promise((resolve) => broken.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`${address(broken)}/v1/models`);
  broken.close();
  assert.equal(response.status, 502);
  assert.match(await response.text(), /upstream unreachable/);
});

test("without a key file the call goes out without any key, the placeholder removed", async () => {
  const open = createGateway(loadConfig({ LITELLM_URL: environment.LITELLM_URL, HINDSIGHT_URL: environment.HINDSIGHT_URL }));
  await new Promise((resolve) => open.listen(0, "127.0.0.1", resolve));
  const seen = await (await fetch(`${address(open)}/v1/models`, { headers: { authorization: "Bearer placeholder" } })).json();
  open.close();
  assert.equal(seen.authorization, undefined);
});

test("a missing or empty key file stops the start and names it", () => {
  assert.throws(() => readSecret("K", { K: join(directory, "absent") }), /absent/);
  assert.throws(() => readSecret("K", { K: secret("empty", "\n") }), /empty/);
  assert.equal(readSecret("K", {}), undefined);
});

test("an upstream address must be http or https", () => {
  assert.throws(() => upstreamUrl("LITELLM_URL", "", { LITELLM_URL: "ftp://x" }), /LITELLM_URL/);
  assert.equal(upstreamUrl("LITELLM_URL", "http://litellm:4000/", {}), "http://litellm:4000");
});
