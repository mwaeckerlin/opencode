#!/usr/bin/env node
// The one change of OpenCode's interface bundle below OPENCODE_BASE_PATH, and
// the check of the build that it still applies.
//
// OpenCode is one compiled executable with the interface embedded; there is
// no build of the interface to configure and no file to patch on disk. The
// interface addresses its server through the origin of the page, which the
// browser script (opencode-base-path.js) puts below the base path, but its
// router reads location.pathname and has no base. The front process (serve.mjs)
// therefore gives the router the base path when it serves the bundle: the
// router factory of Solid Router takes `base` from the browser script when
// the application passes none.
//
// The patch names the code it replaces with a pattern over the minified text,
// independent of the variable names the minifier chose. The build runs
// `patch-upstream.mjs verify`, which starts the OpenCode of the image, reads
// its page, bundle and stylesheets, and stops the build with file and text
// when upstream changed the code.
//
//   patch-upstream.mjs verify   in the image build
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { rewriteCss, rewriteHtml } from "./configuration.mjs";

export class PatchError extends Error {}

const NAME = "[\\w$]+";

// Solid Router's factory of every router component:
//   const{base:n}=t,r=Yl(()=>t.children),i=E(()=>ej(r(),t.base||""))
// becomes
//   const{base:n=globalThis.__opencodeBasePath}=t,r=Yl(()=>t.children),i=E(()=>ej(r(),n||""))
// so the routes and every navigation lie below the base path.
export const ROUTER = {
  name: "the router factory of Solid Router",
  pattern: new RegExp(
    `const\\{base:(${NAME})\\}=(${NAME}),(${NAME})=(${NAME})\\(\\(\\)=>\\2\\.children\\),(${NAME})=(${NAME})\\(\\(\\)=>(${NAME})\\(\\3\\(\\),\\2\\.base\\|\\|""\\)\\)`,
    "g",
  ),
  replacement: 'const{base:$1=globalThis.__opencodeBasePath}=$2,$3=$4(()=>$2.children),$5=$6(()=>$7($3(),$1||""))',
};

// How often a script carries the code the patch replaces.
export function countAnchor(text) {
  return [...text.matchAll(ROUTER.pattern)].length;
}

// A script of the interface as the front process serves it below the base
// path. The bundle that creates the router carries the code once, every other
// script not at all; more than once means upstream changed it.
export function patchScript(file, text) {
  const found = countAnchor(text);
  if (found > 1) {
    throw new PatchError(
      `${file} carries ${ROUTER.name} ${found} times instead of once; upstream changed this code, check whether the patch still applies`,
    );
  }
  return found === 0 ? text : text.replace(ROUTER.pattern, ROUTER.replacement);
}

// The checks of the interface the server delivers, against its page, its
// module scripts and its stylesheets; every finding names its file.
export function verifyInterface(files) {
  const findings = [];
  const html = files["/"];
  if (typeof html !== "string") return ["the page / is missing"];
  if ((html.match(/<head(\s[^>]*)?>/gi) ?? []).length !== 1) findings.push("the page / has no single <head>, where the browser script goes");
  const rebased = rewriteHtml(html, "/x");
  const outside = [...rebased.matchAll(/\s(?:src|srcset|imagesrcset|href|action|formaction|poster|data)\s*=\s*["']\/(?!x\/)(?![/\\])[^"']*/gi)].map((match) => match[0].trim());
  if (outside.length) findings.push(`the page / keeps root-absolute URLs below a base path: ${outside.join(", ")}`);

  const scripts = moduleScripts(html);
  if (!scripts.length) findings.push("the page / loads no module script");
  const anchors = scripts.reduce((sum, script) => sum + countAnchor(files[script] ?? ""), 0);
  if (anchors !== 1) {
    findings.push(
      `the module scripts ${scripts.join(", ")} carry ${ROUTER.name} ${anchors} times instead of once; ` +
        "upstream changed this code, check whether the patch still applies",
    );
  }
  for (const stylesheet of stylesheets(html)) {
    const css = rewriteCss(files[stylesheet] ?? "", "/x");
    const left = [...css.matchAll(/url\(\s*["']?\/(?!x\/)(?![/\\])[^)"']*/gi)].map((match) => match[0]);
    if (left.length) findings.push(`${stylesheet} keeps root-absolute URLs below a base path: ${left.join(", ")}`);
  }
  return findings;
}

export function moduleScripts(html) {
  return [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'](\/[^"']+)["']/gi)].map((match) => match[1]);
}

export function stylesheets(html) {
  return [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["'](\/[^"']+)["']/gi)].map((match) => match[1]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Starts the OpenCode of the image on the loopback interface, without the
// configuration of a stack, and reads what its interface delivers.
async function readInterface(command) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-verify-"));
  const port = await freePort();
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: `${home}/data`, XDG_CONFIG_HOME: `${home}/config`, XDG_CACHE_HOME: `${home}/cache`, XDG_STATE_HOME: `${home}/state` };
  delete env.OPENCODE_GATEWAY_URL;
  delete env.OPENCODE_SERVER_PASSWORD;
  const child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60000;
    let html;
    while (html === undefined) {
      if (child.exitCode !== null) throw new PatchError(`${command} serve stopped with ${child.exitCode}: ${output}`);
      if (Date.now() > deadline) throw new PatchError(`${command} serve did not answer within 60s: ${output}`);
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      if (response?.ok) html = await response.text();
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const files = { "/": html };
    for (const file of [...moduleScripts(html), ...stylesheets(html)]) {
      const response = await fetch(origin + file, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new PatchError(`${file} answered ${response.status}`);
      files[file] = await response.text();
    }
    return files;
  } finally {
    child.kill("SIGTERM");
    await exited;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const [command, executable = "/usr/local/bin/opencode"] = process.argv.slice(2);
  try {
    if (command !== "verify") throw new PatchError("usage: patch-upstream.mjs verify [<opencode executable>]");
    const findings = verifyInterface(await readInterface(executable));
    if (findings.length) throw new PatchError(findings.join("\n"));
    console.log("patch-upstream: the interface of OpenCode serves below a base path");
  } catch (error) {
    if (!(error instanceof PatchError)) throw error;
    console.error(`patch-upstream: ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
