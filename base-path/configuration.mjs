// Settings of the front process and the helpers it uses on every request:
// the base path, the link to the login page of the LiteLLM subscriptions, and
// the alert relay.
//
// serve.mjs, the front process of the image when OPENCODE_BASE_PATH,
// LITELLM_SUBSCRIPTION_LOGIN_URL or OPENCODE_ALERT_TOKEN_SHA256 is set, checks
// the settings once at start. Without any of them the image starts OpenCode
// directly, as before.
import crypto from "node:crypto";

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

// OpenCode listens here, on the loopback interface, behind the front process.
export const UPSTREAM_PORT = 14096;

// The browser script below the base path; the front process serves it itself.
export const SCRIPT_NAME = "opencode-base-path.js";

// The stylesheet of the login link, served by the front process from the
// origin of the page, which the security policy of OpenCode allows.
export const LOGIN_STYLE_NAME = "opencode-login-link.css";

// The ids of the bar and the login link in the page; the browser script leaves
// the address of an element with KEEP_URL as it is.
export const LOGIN_BAR_ID = "litellm-subscription-bar";
export const LOGIN_LINK_ID = "litellm-subscription-login";
export const KEEP_URL = "data-opencode-keep-url";

// The path of the alert relay, at the root and below the base path.
export const ALERT_PATH = "/alert";

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

// LITELLM_SUBSCRIPTION_LOGIN_URL: "" for no link, otherwise an http or https
// address as the browser opens it.
export function parseLoginUrl(value) {
  const raw = value ?? "";
  if (raw === "") return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || !["http:", "https:"].includes(url.protocol) || /\s/.test(raw) || !url.hostname) {
    throw new ConfigurationError(
      `LITELLM_SUBSCRIPTION_LOGIN_URL is ${JSON.stringify(value)}; it must be an http or https address such as https://litellm.example.com/mysubs`,
    );
  }
  return url.href;
}

// OPENCODE_ALERT_TOKEN_SHA256: "" for no alert relay, otherwise the SHA-256
// digest of the token, 64 hexadecimal digits; the token itself never reaches
// the sandbox.
export function parseTokenDigest(value) {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "") return "";
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new ConfigurationError(
      `OPENCODE_ALERT_TOKEN_SHA256 is ${JSON.stringify(value)}; it must be the SHA-256 digest of the token, 64 hexadecimal digits, as sha256sum prints it`,
    );
  }
  return raw;
}

// OPENCODE_ALERT_SESSION_TITLE: the title of the session that collects the alerts.
export function parseSessionTitle(value) {
  const raw = (value ?? "").trim();
  if (raw === "") return "Alerts";
  if (/[\u0000-\u001f\u007f]/.test(raw) || raw.length > 200) {
    throw new ConfigurationError(
      `OPENCODE_ALERT_SESSION_TITLE is ${JSON.stringify(value)}; it must be one line of at most 200 characters`,
    );
  }
  return raw;
}

// OPENCODE_ALERT_MAX_BYTES: the largest alert body the relay accepts.
export function parseByteLimit(value) {
  const raw = value ?? "";
  const bytes = raw === "" ? 1048576 : Number(raw);
  if (!/^\d*$/.test(raw) || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new ConfigurationError(`OPENCODE_ALERT_MAX_BYTES is ${JSON.stringify(value)}; it must be a number of bytes from 1`);
  }
  return bytes;
}

// Whether the bearer token of an Authorization header has the configured
// digest; the comparison takes the same time for every token.
export function tokenMatches(header, digest) {
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "");
  if (!digest || !match) return false;
  const given = crypto.createHash("sha256").update(match[1], "utf8").digest();
  return crypto.timingSafeEqual(given, Buffer.from(digest, "hex"));
}

// The text an alert puts into the alert session: the title and message of a
// Grafana webhook, the alerts of an Alertmanager webhook, any other JSON as it
// is, plain text as it is; the login link last where one is set.
export function alertText(body, contentType = "", loginUrl = "") {
  const raw = body.trim();
  let payload;
  if (/json/i.test(contentType) || /^[[{]/.test(raw)) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = undefined;
    }
  }
  let text = raw;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const lines = [];
    const status = typeof payload.status === "string" ? payload.status.toUpperCase() : "";
    const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
    if (typeof payload.title === "string" && payload.title.trim()) lines.push(payload.title.trim());
    else if (status) lines.push(`[${status}:${alerts.length}] ${payload.commonLabels?.alertname ?? payload.receiver ?? "alert"}`);
    if (typeof payload.message === "string" && payload.message.trim()) {
      lines.push("", payload.message.trim());
    } else if (alerts.length) {
      lines.push("");
      for (const alert of alerts) {
        const name = alert?.labels?.alertname ?? "alert";
        const about = alert?.annotations?.summary ?? alert?.annotations?.description ?? "";
        lines.push(`- ${alert?.status ?? status.toLowerCase()}: ${name}${about ? `: ${about}` : ""}${alert?.generatorURL ? ` (${alert.generatorURL})` : ""}`);
      }
    }
    text = lines.length ? lines.join("\n") : JSON.stringify(payload, null, 2);
  } else if (payload !== undefined) {
    text = JSON.stringify(payload, null, 2);
  }
  if (!text) return "";
  return loginUrl ? `${text}\n\nSign in to the subscriptions again: ${loginUrl}` : text;
}

// An attribute value in the page.
function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

// The page: below a base path the browser script ahead of everything else in
// the head, and every root-absolute URL of an element below the base path;
// with a login address the stylesheet of the link at the end of the head and
// a bar with the link as the first element of the body, before the interface,
// as markup without any script.
export function rewriteHtml(html, basePath, loginUrl = "") {
  let page = html;
  if (basePath) {
    page = page.replace(
      /(\s(?:src|href|action|formaction|poster)\s*=\s*)(["'])\/(?![/\\])/gi,
      (match, attribute, quote) => `${attribute}${quote}${basePath}/`,
    );
    page = page.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n<script src="${basePath}/${SCRIPT_NAME}"></script>`);
  }
  if (loginUrl) {
    page = page.replace(/<\/head>/i, (end) => `<link rel="stylesheet" href="${basePath}/${LOGIN_STYLE_NAME}">\n${end}`);
    page = page.replace(
      /<body(\s[^>]*)?>/i,
      (body) =>
        `${body}\n<nav id="${LOGIN_BAR_ID}" aria-label="LiteLLM subscriptions"><a id="${LOGIN_LINK_ID}" ${KEEP_URL} href="${escapeAttribute(loginUrl)}" target="_blank" rel="noopener noreferrer">Subscription login</a></nav>`,
    );
  }
  return page;
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
