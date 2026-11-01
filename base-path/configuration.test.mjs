// Unit tests of base-path/configuration.mjs: the settings and the helpers the
// front process uses, against the page and the web manifest OpenCode 1.19.4
// serves and the default webhook payload of the Grafana documentation
// (fixtures/).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import crypto from "node:crypto";

import {
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

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("the base path is a path, unset, empty or / is the root", () => {
  assert.equal(parseBasePath(undefined), "");
  assert.equal(parseBasePath(""), "");
  assert.equal(parseBasePath("/"), "");
  assert.equal(parseBasePath("/opencode"), "/opencode");
  assert.equal(parseBasePath("/opencode/"), "/opencode");
  assert.equal(parseBasePath("/tools/open-code_1.x~"), "/tools/open-code_1.x~");
});

test("a base path that is no path stops the start and names the variable", () => {
  for (const value of ["opencode", " /opencode", "/opencode ", "/a b", "//evil.example", "/x/../y", "/..", "/x/./y", "/a<script>", "https://host/opencode", "/%2e%2e", " "]) {
    assert.throws(() => parseBasePath(value), /OPENCODE_BASE_PATH is .*; it must be a path such as \/opencode/, JSON.stringify(value));
  }
});

test("the port of the front process is a port other than the one of OpenCode behind it", () => {
  assert.equal(parsePort(undefined), 4096);
  assert.equal(parsePort(""), 4096);
  assert.equal(parsePort("8080"), 8080);
  for (const value of ["0", "65536", "http", "80a", "-1", "1.5"]) {
    assert.throws(() => parsePort(value), /OPENCODE_PORT is .*; it must be a port number from 1 to 65535/, value);
  }
  assert.throws(() => parsePort(String(UPSTREAM_PORT)), new RegExp(`OPENCODE_PORT is ${UPSTREAM_PORT}, the port OpenCode itself listens on behind OPENCODE_BASE_PATH`));
});

test("a request below the base path loses the base path, the bare base path goes to its slash form", () => {
  assert.deepEqual(routeRequestUrl("/opencode/global/health?x=1", "/opencode"), { kind: "inside", url: "/global/health?x=1" });
  assert.deepEqual(routeRequestUrl("/opencode/", "/opencode"), { kind: "inside", url: "/" });
  assert.deepEqual(routeRequestUrl("/opencode", "/opencode"), { kind: "bare", url: "/opencode/" });
  assert.deepEqual(routeRequestUrl("/opencode?next=%2F", "/opencode"), { kind: "bare", url: "/opencode/?next=%2F" });
  assert.deepEqual(routeRequestUrl("/opencodex/session", "/opencode"), { kind: "outside", url: "/opencodex/session" });
  assert.deepEqual(routeRequestUrl("/session", "/opencode"), { kind: "outside", url: "/session" });
  assert.deepEqual(routeRequestUrl("/opencode/session", ""), { kind: "outside", url: "/opencode/session" });
  assert.deepEqual(routeRequestUrl("http://host/opencode/session", "/opencode"), { kind: "outside", url: "http://host/opencode/session" });
});

test("a root-absolute redirect gets the base path, any other stays", () => {
  assert.equal(prefixLocation("/session?x=1", "/opencode"), "/opencode/session?x=1");
  assert.equal(prefixLocation("/", "/opencode"), "/opencode/");
  assert.equal(prefixLocation("https://opencode.ai/auth", "/opencode"), "https://opencode.ai/auth");
  assert.equal(prefixLocation("//cdn.example.org/x", "/opencode"), "//cdn.example.org/x");
  assert.equal(prefixLocation("/\\evil.example", "/opencode"), "/\\evil.example");
  assert.equal(prefixLocation("relative", "/opencode"), "relative");
  assert.equal(prefixLocation("/session", ""), "/session");
});

test("the page loads the browser script first and names its files below the base path", () => {
  const html = rewriteHtml(fixture("index.html"), "/opencode");
  assert.match(html, /<head>\n<script src="\/opencode\/opencode-base-path.js"><\/script>\n\s*<meta charset="utf-8" \/>/);
  assert.ok(html.indexOf("opencode-base-path.js") < html.indexOf("oc-theme-preload-script"));
  assert.match(html, /<script type="module" crossorigin src="\/opencode\/assets\/index-BVEDUzgq.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" crossorigin href="\/opencode\/assets\/index-DLiUNAg_.css">/);
  assert.match(html, /href="\/opencode\/favicon-v3.svg"/);
  assert.match(html, /href="\/opencode\/site.webmanifest"/);
  assert.deepEqual([...html.matchAll(/\s(?:src|href)="\/(?!opencode\/)[^"]*"/g)].map((match) => match[0]), []);
  // the inline theme script keeps its text, so its hash in the content security policy still holds
  const theme = (text) => text.match(/<script id="oc-theme-preload-script">[\s\S]*?<\/script>/)[0];
  assert.equal(theme(html), theme(fixture("index.html")));
  assert.equal(rewriteHtml(fixture("index.html"), ""), fixture("index.html"));
});

test("a protocol-relative, foreign or relative URL of the page stays", () => {
  const html = '<head><script src="//cdn.example.org/x.js"></script><a href="https://opencode.ai/">x</a><img src=\'relative.png\'><img src=\'/a.png\'>';
  assert.equal(rewriteHtml(html, "/opencode"),
    '<head>\n<script src="/opencode/opencode-base-path.js"></script><script src="//cdn.example.org/x.js"></script><a href="https://opencode.ai/">x</a><img src=\'relative.png\'><img src=\'/opencode/a.png\'>');
});

test("the stylesheet names its fonts below the base path", () => {
  const css = "@font-face{src:url(/assets/Inter.ttf)}@font-face{src:url(\"/assets/KaTeX_Main-Regular-B22Nviop.woff2\") format(\"woff2\"),url('/assets/x.woff')}a{background:url(data:image/png;base64,AA)}b{background:url(//cdn.example.org/x.png)}";
  assert.equal(rewriteCss(css, "/opencode"),
    "@font-face{src:url(/opencode/assets/Inter.ttf)}@font-face{src:url(\"/opencode/assets/KaTeX_Main-Regular-B22Nviop.woff2\") format(\"woff2\"),url('/opencode/assets/x.woff')}a{background:url(data:image/png;base64,AA)}b{background:url(//cdn.example.org/x.png)}");
  assert.equal(rewriteCss(css, ""), css);
});

const LOGIN = "https://swarm-01/litellm/mysubs?next=/a&b=\"c\"";

test("the login address is an http or https address, unset or empty shows no link", () => {
  assert.equal(parseLoginUrl(undefined), "");
  assert.equal(parseLoginUrl(""), "");
  assert.equal(parseLoginUrl("https://litellm.example.com/mysubs"), "https://litellm.example.com/mysubs");
  assert.equal(parseLoginUrl("http://litellm:4000/mysubs/"), "http://litellm:4000/mysubs/");
  for (const value of ["litellm/mysubs", "/mysubs", "javascript:alert(1)", "ftp://host/x", "https://", "https://host/a b", " https://host/", "data:text/html,x"]) {
    assert.throws(() => parseLoginUrl(value), /LITELLM_SUBSCRIPTION_LOGIN_URL is .*; it must be an http or https address/, JSON.stringify(value));
  }
});

test("the page carries the bar with the login link before the interface, at the root and below the base path, with its address escaped", () => {
  const url = parseLoginUrl(LOGIN);
  for (const base of ["", "/opencode"]) {
    const html = rewriteHtml(fixture("index.html"), base, url);
    assert.match(html, new RegExp(`<link rel="stylesheet" href="${base}/opencode-login-link.css">\\n</head>`));
    assert.match(html, /<body [^>]*>\n<nav id="litellm-subscription-bar" aria-label="LiteLLM subscriptions"><a id="litellm-subscription-login" data-opencode-keep-url href="https:\/\/swarm-01\/litellm\/mysubs\?next=\/a&amp;b=%22c%22" target="_blank" rel="noopener noreferrer">Subscription login<\/a><\/nav>\n\s*<noscript>/);
    assert.ok(html.indexOf("litellm-subscription-bar") < html.indexOf('id="root"'));
    // the link is markup; the page gets no script of its own for it
    assert.equal(html.match(/<script/g).length, fixture("index.html").match(/<script/g).length + (base ? 1 : 0));
  }
  assert.equal(rewriteHtml(fixture("index.html"), "", ""), fixture("index.html"));
});

test("the alert token is given as its SHA-256 digest", () => {
  const digest = crypto.createHash("sha256").update("token of the test", "utf8").digest("hex");
  assert.equal(parseTokenDigest(undefined), "");
  assert.equal(parseTokenDigest(""), "");
  assert.equal(parseTokenDigest(digest.toUpperCase()), digest);
  assert.equal(parseTokenDigest(` ${digest}\n`), digest);
  for (const value of ["token of the test", digest.slice(1), `${digest}0`, "g".repeat(64)]) {
    assert.throws(() => parseTokenDigest(value), /OPENCODE_ALERT_TOKEN_SHA256 is .*; it must be the SHA-256 digest of the token/, value);
  }
  assert.equal(tokenMatches("Bearer token of the test", digest), false);
  assert.equal(tokenMatches("Bearer tokenofthetest", crypto.createHash("sha256").update("tokenofthetest").digest("hex")), true);
  assert.equal(tokenMatches("bearer  tokenofthetest ", crypto.createHash("sha256").update("tokenofthetest").digest("hex")), true);
  for (const header of [undefined, "", "Bearer", "Bearer wrong", "Basic dG9rZW5vZnRoZXRlc3Q=", "tokenofthetest"]) {
    assert.equal(tokenMatches(header, crypto.createHash("sha256").update("tokenofthetest").digest("hex")), false, String(header));
  }
  assert.equal(tokenMatches("Bearer tokenofthetest", ""), false);
});

test("the alert session has a title of one line, the body a limit", () => {
  assert.equal(parseSessionTitle(undefined), "Alerts");
  assert.equal(parseSessionTitle("  "), "Alerts");
  assert.equal(parseSessionTitle(" Grafana alerts "), "Grafana alerts");
  for (const value of ["two\nlines", "tab\there", "x".repeat(201)]) {
    assert.throws(() => parseSessionTitle(value), /OPENCODE_ALERT_SESSION_TITLE is .*; it must be one line of at most 200 characters/);
  }
  assert.equal(parseByteLimit(undefined), 1048576);
  assert.equal(parseByteLimit(""), 1048576);
  assert.equal(parseByteLimit("4096"), 4096);
  for (const value of ["0", "-1", "1.5", "1MB", "9007199254740993"]) {
    assert.throws(() => parseByteLimit(value), /OPENCODE_ALERT_MAX_BYTES is .*; it must be a number of bytes from 1/, value);
  }
});

test("a Grafana webhook becomes its title and message, with the login link last", () => {
  const body = fixture("grafana-webhook.json");
  const payload = JSON.parse(body);
  assert.equal(alertText(body, "application/json"), `${payload.title}\n\n${payload.message.trim()}`);
  assert.equal(alertText(body, "application/json", "https://litellm.example.com/mysubs"),
    `${payload.title}\n\n${payload.message.trim()}\n\nSign in to the subscriptions again: https://litellm.example.com/mysubs`);
});

test("an alert without a message lists its alerts, other JSON and plain text stay as they are", () => {
  const { title, message, ...payload } = JSON.parse(fixture("grafana-webhook.json"));
  assert.equal(alertText(JSON.stringify(payload), "application/json"), [
    "[FIRING:2] My Super Webhook",
    "",
    "- firing: High memory usage: This alert was triggered for zone us-1 (https://play.grafana.org/alerting/1afz29v7z/edit)",
    "- firing: High CPU usage: This alert was triggered for zone eu-1 (https://play.grafana.org/alerting/d1rdpdv7k/edit)",
  ].join("\n"));
  assert.equal(alertText('{"metric":"litellm_deployment_failure_responses","value":3}', ""), '{\n  "metric": "litellm_deployment_failure_responses",\n  "value": 3\n}');
  assert.equal(alertText("[1,2]", "application/json"), "[\n  1,\n  2\n]");
  assert.equal(alertText("  the login of mysubs/gpt-5 failed  \n", "text/plain"), "the login of mysubs/gpt-5 failed");
  assert.equal(alertText("{not json", "application/json"), "{not json");
  assert.equal(alertText("  \n", "text/plain", "https://litellm.example.com/mysubs"), "");
});

test("the web manifest names its icons and its start relative to itself", () => {
  const manifest = JSON.parse(rewriteManifest(fixture("site.webmanifest")));
  assert.equal(manifest.id, "./");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.deepEqual(manifest.icons.map((icon) => icon.src), ["./web-app-manifest-192x192.png", "./web-app-manifest-512x512.png"]);
  assert.equal(manifest.name, "OpenCode");
});
