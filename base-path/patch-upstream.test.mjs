// Unit tests of base-path/patch-upstream.mjs: the router patch on the code
// OpenCode 1.19.4 carries (fixtures/router.js, cut from its bundle), and the
// build check against the page it serves (fixtures/index.html).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { PatchError, countAnchor, moduleScripts, patchScript, stylesheets, verifyInterface } from "./patch-upstream.mjs";

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ROUTER = fixture("router.js");

test("the router factory takes the base path of the browser script when the application passes none", () => {
  assert.equal(countAnchor(ROUTER), 1);
  const patched = patchScript("/assets/index-BVEDUzgq.js", ROUTER);
  assert.ok(patched.startsWith(
    'const qfe=e=>t=>{const{base:n=globalThis.__opencodeBasePath}=t,r=Yl(()=>t.children),i=E(()=>ej(r(),n||""));let s;const o=Hfe(e,i,()=>s,{base:n,',
  ), patched);
  assert.equal(countAnchor(patched), 0);
});

test("the patch does not depend on the names the minifier chose", () => {
  const renamed = ROUTER.replaceAll("Yl(", "a$(").replaceAll("ej(", "Q_(").replace("{const{base:n}=t,", "{const{base:z}=p,").replaceAll("t.children", "p.children").replace('t.base||""', 'p.base||""');
  assert.equal(countAnchor(renamed), 1);
  assert.match(patchScript("x.js", renamed), /const\{base:z=globalThis\.__opencodeBasePath\}=p,r=a\$\(\(\)=>p\.children\),i=E\(\(\)=>Q_\(r\(\),z\|\|""\)\)/);
});

test("a script without the router stays as it is, the code twice stops with file and text", () => {
  assert.equal(patchScript("/assets/abap-BdImnpbu.js", "export default 1"), "export default 1");
  assert.throws(() => patchScript("/assets/index.js", ROUTER + ROUTER),
    (error) => error instanceof PatchError && /\/assets\/index.js carries the router factory of Solid Router 2 times instead of once; upstream changed this code/.test(error.message));
});

test("the build check passes on the interface of OpenCode", () => {
  const html = fixture("index.html");
  assert.deepEqual(moduleScripts(html), ["/assets/index-BVEDUzgq.js"]);
  assert.deepEqual(stylesheets(html), ["/assets/index-DLiUNAg_.css"]);
  assert.deepEqual(verifyInterface({
    "/": html,
    "/assets/index-BVEDUzgq.js": `import("./abap-BdImnpbu.js");${ROUTER}`,
    "/assets/index-DLiUNAg_.css": "@font-face{src:url(/assets/Inter.ttf)}",
  }), []);
});

test("the build check stops when upstream changed the router, the page or the stylesheet", () => {
  const html = fixture("index.html");
  const changed = ROUTER.replace('t.base||""', 't.base??""');
  assert.match(verifyInterface({ "/": html, "/assets/index-BVEDUzgq.js": changed, "/assets/index-DLiUNAg_.css": "" }).join("\n"),
    /the module scripts \/assets\/index-BVEDUzgq.js carry the router factory of Solid Router 0 times instead of once/);
  assert.match(verifyInterface({ "/": html.replace("<head>", ""), "/assets/index-BVEDUzgq.js": ROUTER, "/assets/index-DLiUNAg_.css": "" }).join("\n"),
    /the page \/ has no single <head>/);
  assert.match(verifyInterface({ "/": html.replace("<title>", '<img srcset="/x.png 1x"><title>'), "/assets/index-BVEDUzgq.js": ROUTER, "/assets/index-DLiUNAg_.css": "" }).join("\n"),
    /the page \/ keeps root-absolute URLs below a base path: srcset="\/x.png 1x/);
  assert.deepEqual(verifyInterface({ "/": html.replace("<title>", '<img src = "/x.png"><title>'), "/assets/index-BVEDUzgq.js": ROUTER, "/assets/index-DLiUNAg_.css": "" }), []);
  assert.deepEqual(verifyInterface({}), ["the page / is missing"]);
  assert.match(verifyInterface({ "/": "<html><head></head></html>" }).join("\n"), /the page \/ loads no module script/);
});
