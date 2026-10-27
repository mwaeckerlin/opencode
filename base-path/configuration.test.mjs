// Unit tests of base-path/configuration.mjs: the settings and the helpers the
// front process uses, against the page and the web manifest OpenCode 1.19.4
// serves (fixtures/).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  UPSTREAM_PORT,
  parseBasePath,
  parsePort,
  prefixLocation,
  rewriteCss,
  rewriteHtml,
  rewriteManifest,
  routeRequestUrl,
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

test("the web manifest names its icons and its start relative to itself", () => {
  const manifest = JSON.parse(rewriteManifest(fixture("site.webmanifest")));
  assert.equal(manifest.id, "./");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.deepEqual(manifest.icons.map((icon) => icon.src), ["./web-app-manifest-192x192.png", "./web-app-manifest-512x512.png"]);
  assert.equal(manifest.name, "OpenCode");
});
