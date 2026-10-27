// Settings of the base path and the helpers that serve OpenCode below it.
//
// serve.mjs, the front process of the image when OPENCODE_BASE_PATH is set,
// checks the settings once and uses the helpers on every request. Without
// OPENCODE_BASE_PATH the image starts OpenCode directly, as before.

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

// OpenCode listens here, on the loopback interface, behind the front process.
export const UPSTREAM_PORT = 14096;

// The browser script below the base path; the front process serves it itself.
export const SCRIPT_NAME = "opencode-base-path.js";

export class ConfigurationError extends Error {}

// OPENCODE_BASE_PATH: "" for the root, otherwise "/segment[/segment...]"
// without a trailing slash.
export function parseBasePath(value) {
  const raw = value ?? "";
  if (raw === "" || raw === "/") return "";
  const trimmed = raw.replace(/\/+$/, "");
  const segments = trimmed.split("/");
  const valid =
    segments.length >= 2 &&
    segments[0] === "" &&
    segments.slice(1).every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..");
  if (!valid) {
    throw new ConfigurationError(
      `OPENCODE_BASE_PATH is ${JSON.stringify(value)}; it must be a path such as /opencode: ` +
        "a leading slash, then segments of letters, digits, '.', '_', '~' and '-'",
    );
  }
  return trimmed;
}

// OPENCODE_PORT: the port the front process listens on; OpenCode itself takes
// UPSTREAM_PORT, so the two must differ.
export function parsePort(value) {
  const raw = value ?? "";
  const port = raw === "" ? 4096 : Number(raw);
  if (!/^\d*$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(`OPENCODE_PORT is ${JSON.stringify(value)}; it must be a port number from 1 to 65535`);
  }
  if (port === UPSTREAM_PORT) {
    throw new ConfigurationError(
      `OPENCODE_PORT is ${port}, the port OpenCode itself listens on behind OPENCODE_BASE_PATH; choose another port`,
    );
  }
  return port;
}

// Where a request path lies relative to the base path:
// "inside" with the path below it, "bare" with the address of its slash form,
// "outside" unchanged. Requests outside the base path reach OpenCode as at the
// root, for the health check and for the agents that address the server
// inside the stack.
export function routeRequestUrl(url, basePath) {
  if (!basePath || typeof url !== "string" || url[0] !== "/") return { kind: "outside", url };
  const end = url.search(/[?#]/);
  const path = end < 0 ? url : url.slice(0, end);
  const rest = end < 0 ? "" : url.slice(end);
  if (path === basePath) return { kind: "bare", url: `${basePath}/${rest}` };
  if (path.startsWith(`${basePath}/`)) return { kind: "inside", url: url.slice(basePath.length) };
  return { kind: "outside", url };
}

// A root-absolute address of OpenCode gets the base path in front; a foreign,
// protocol-relative or relative address stays as it is.
export function prefixLocation(value, basePath) {
  if (!basePath || typeof value !== "string") return value;
  if (value[0] !== "/" || value[1] === "/" || value[1] === "\\") return value;
  return basePath + value;
}

// The page: the browser script ahead of everything else in the head, and
// every root-absolute URL of an element below the base path.
export function rewriteHtml(html, basePath) {
  if (!basePath) return html;
  const rebased = html.replace(
    /(\s(?:src|href|action|formaction|poster)\s*=\s*)(["'])\/(?![/\\])/gi,
    (match, attribute, quote) => `${attribute}${quote}${basePath}/`,
  );
  return rebased.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n<script src="${basePath}/${SCRIPT_NAME}"></script>`);
}

// A stylesheet: every root-absolute url() below the base path, such as the
// fonts the stylesheet of the interface names.
export function rewriteCss(css, basePath) {
  if (!basePath) return css;
  return css.replace(/(url\(\s*["']?)\/(?![/\\])/gi, (match, opening) => `${opening}${basePath}/`);
}

// The web manifest addresses its icons and its start page relative to itself,
// so they lie below the base path wherever the manifest is served.
export function rewriteManifest(text) {
  const manifest = JSON.parse(text);
  const relative = (value) => (typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? `.${value}` : value);
  for (const key of ["id", "start_url", "scope"]) {
    if (key in manifest) manifest[key] = relative(manifest[key]);
  }
  for (const icon of manifest.icons ?? []) icon.src = relative(icon.src);
  for (const shortcut of manifest.shortcuts ?? []) shortcut.url = relative(shortcut.url);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
