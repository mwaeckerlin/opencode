# OpenCode Docker Images

[mwaeckerlin/opencode] runs [OpenCode], the open source coding agent, as a server with its web interface, split into two images so that the agent never holds a key:

- **`mwaeckerlin/opencode:sandbox`** — OpenCode with its web interface and the full toolset of [mwaeckerlin/sandbox-base]. OpenCode runs its tools (bash, edit, write) in the same process that talks to the model, so this container holds no secret at all.
- **`mwaeckerlin/opencode:gateway`** — the only container with keys. It forwards the model calls of the sandbox to LiteLLM and its memory calls to [Hindsight], and replaces the Authorization header with the real key, read from a Docker secret.

The sandbox reaches nothing but its gateway. OpenCode sends a placeholder where it expects a key; the end-to-end test measures that the real keys never reach the sandbox.

All features are listed in [FEATURES.md](FEATURES.md), all tests in [TESTS.md](TESTS.md).

## Usage

[docker-compose.yml](docker-compose.yml) shows the split: the sandbox on an internal network with the gateway only, the gateway also on the network of LiteLLM and Hindsight. Browse to port 4096 of the sandbox; behind a reverse proxy, put an authentication in front of it, since whoever reaches the web interface controls the agent.

### Below a Base Path

With `OPENCODE_BASE_PATH`, the sandbox itself serves the web interface below that path: the page, its files, every API call, the event stream, the websockets of the terminal and its redirects. The reverse proxy forwards the path unchanged, with no StripPrefix and no rewriting of pages or bundles. The bare path `/opencode` redirects to `/opencode/`. Agents of the stack keep addressing the server at its root, `http://opencode-sandbox:4096`.

```yaml
services:
  opencode-sandbox:
    image: mwaeckerlin/opencode:sandbox
    environment:
      OPENCODE_GATEWAY_URL: http://opencode-gateway:8080
      OPENCODE_MODELS: gpt-4o-mini
      OPENCODE_BASE_PATH: /opencode
      OPENCODE_SERVER_PASSWORD_FILE: /run/secrets/opencode_server_password
    secrets:
      - opencode_server_password
    volumes:
      - workspace:/workspace
    networks:
      - sandbox
      - proxy
    deploy:
      labels:
        traefik.enable: "true"
        traefik.http.routers.opencode.rule: PathPrefix(`/opencode`)
        traefik.http.services.opencode.loadbalancer.server.port: "4096"
```

A stack that strips the path at the proxy drops the StripPrefix middleware when it sets `OPENCODE_BASE_PATH`; a `command` of the stack replaces the start of the image, and OpenCode then serves at the root only.

### Development Agent for Other Agents

The sandbox runs one central OpenCode server; the web interface and the agents that delegate development to it share this instance. Hermes, OpenClaw or any other agent reaches port 4096 over a network of its own. An agent that needs the answer in its conversation sends the task through the server API: it opens a session and posts the task as a message, and the response carries the parts of the answer, the text among them:

```bash
SESSION=$(curl -fsS -u "opencode:${OPENCODE_SERVER_PASSWORD}" -X POST -H "Content-Type: application/json" -d '{}' http://opencode-sandbox:4096/session | jq -r .id)
curl -fsS -u "opencode:${OPENCODE_SERVER_PASSWORD}" -X POST -H "Content-Type: application/json" \
    -d '{"model":{"providerID":"litellm","modelID":"<model>"},"parts":[{"type":"text","text":"<task>"}]}' \
    "http://opencode-sandbox:4096/session/${SESSION}/message" | jq -r '.parts[] | select(.type == "text") | .text'
```

`opencode run --attach http://opencode-sandbox:4096 --model litellm/<model> "<task>"` hands the task to the server as well, and the work shows in the web interface. It ends as soon as the server has taken the task and prints the answer only when it arrives before that: in attach mode, OpenCode's `run` does not wait for the stream of the answer (`packages/opencode/src/cli/cmd/run.ts`, `finish()`). The end-to-end test measured it with a mock model that answers at once: the run printed the header of the answer and no text.

With a server password, the delegating agent passes it as basic authentication with the user name `opencode`, and `opencode run` takes it as `OPENCODE_SERVER_PASSWORD` or `--password`.

### Subscription Login

Models that LiteLLM runs on a subscription, such as a ChatGPT plan, stop answering when their login expires. With `LITELLM_SUBSCRIPTION_LOGIN_URL`, the address of the login page of these subscriptions in LiteLLM, the user finds the way back in two places:

- **In the web interface:** the link «Subscription login» stands at the right end of a narrow bar above the interface, at the root and below a base path, and opens the login page in a window of its own.
- **In the chat:** when an answer of a subscription model fails, the session gets a message with the error of LiteLLM and the link, and the model does not answer it:

```text
The subscription model mysubs/gpt-5 failed: litellm.AuthenticationError: …

Sign in to the subscriptions again: https://litellm.example.com/mysubs
```

A subscription model is a model of the provider `litellm` whose name starts with `LITELLM_SUBSCRIPTION_MODEL_PREFIX`, `mysubs/` by default. Every failure of such a model posts the link, whatever LiteLLM names as the cause; an answer the user stops gets none, and neither does a failing model outside the subscriptions.

### Alerts in the Chat

With `OPENCODE_ALERT_TOKEN_SHA256`, the sandbox keeps one session for alerts, «Alerts» by default, and takes a webhook of Grafana or Alertmanager into it as a message the model does not answer. The session is found again by its title on every start and created where none exists, also after it was deleted in the web interface. Where `LITELLM_SUBSCRIPTION_LOGIN_URL` is set, every alert ends with the login link.

| | |
| --- | --- |
| URL | `http://opencode-sandbox:4096/alert` from a network the sender shares with the sandbox; behind a reverse proxy below a base path, such as `https://swarm-01/opencode/alert` |
| Method | `POST` or `PUT` |
| Authentication | `Authorization: Bearer <alert token>`; the sandbox holds the SHA-256 digest of the token alone |
| Payload | the default JSON of a Grafana webhook (its `title` and `message` become the message), the JSON of an Alertmanager webhook (one line per alert: status, `alertname`, `summary` or `description`, `generatorURL`), any other JSON as it stands, or plain text; at most `OPENCODE_ALERT_MAX_BYTES` |
| Answer | `200` with `{"session": "<id>", "message": "<id>"}`; `401` without the right token, `400` for an empty body, `405` for another method, `413` for a larger body, `502` with the cause where OpenCode does not take it |

Create the token once, as one word without a line break, and its digest; the token goes to the sender, the digest into `OPENCODE_ALERT_TOKEN_SHA256` of the sandbox:

```bash
openssl rand -hex 32 | tr -d '\n' > opencode-alert-token
sha256sum < opencode-alert-token
```

In Grafana, the contact point of the type «Webhook» gets the URL, the method `POST`, the «Authentication Header Scheme» `Bearer` and the token as «Authentication Header Credentials». In Alertmanager, the receiver names the token file:

```yaml
receivers:
  - name: opencode
    webhook_configs:
      - url: http://opencode-sandbox:4096/alert
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/opencode-alert-token
```

## Administration

### Sandbox

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_GATEWAY_URL` | `http://opencode-gateway:8080` | Address of the gateway |
| `OPENCODE_MODELS` | *(empty)* | Comma separated model names of LiteLLM; the first one is the default model |
| `OPENCODE_SMALL_MODEL` | *(empty)* | Model name of LiteLLM for small tasks such as session titles; empty: OpenCode chooses |
| `HINDSIGHT_SHARED_BANK` | `shared` | Memory bank shared by all agents, MCP server `hindsight-shared` |
| `HINDSIGHT_OWN_BANK` | `opencode` | Memory bank of OpenCode alone, MCP server `hindsight-own` |
| `OPENCODE_PORT` | `4096` | Port of the web interface; not `14096`, where OpenCode itself listens behind `OPENCODE_BASE_PATH` |
| `OPENCODE_BASE_PATH` | *(empty)* | Path below which the web interface is served, such as `/opencode`; empty or `/` serves at the root. A value without a leading slash, with a space, or with a `.` or `..` segment stops the start with a message that names the variable |
| `OPENCODE_SERVER_PASSWORD_FILE` | *(empty)* | File with the password of the server, a Docker secret; optional: with it, the web interface and every attaching agent need the password (user `opencode`), without it the server is open to whoever reaches port 4096 |
| `LITELLM_SUBSCRIPTION_LOGIN_URL` | *(empty)* | Address of the login page of the LiteLLM subscriptions, http or https, such as `https://litellm.example.com/mysubs`; with it, the web interface shows the link «Subscription login», and a failed subscription model posts it into its session. Any other value stops the start with a message that names the variable |
| `LITELLM_SUBSCRIPTION_MODEL_PREFIX` | `mysubs/` | Start of the names of the LiteLLM models that run on a subscription |
| `OPENCODE_ALERT_TOKEN_SHA256` | *(empty)* | SHA-256 digest of the alert token, 64 hexadecimal digits; with it, `/alert` takes alerts into the alert session. Any other value stops the start |
| `OPENCODE_ALERT_SESSION_TITLE` | `Alerts` | Title of the alert session, one line of at most 200 characters |
| `OPENCODE_ALERT_MAX_BYTES` | `1048576` | Largest alert the relay takes, in bytes; a larger one answers 413 |

OpenCode and the configuration from these variables come with [mwaeckerlin/sandbox-base]: its command `opencode` writes them into `OPENCODE_CONFIG_CONTENT` on every start, and `/entrypoint.sh --print-config` prints it. A new release of OpenCode arrives with the next build of `mwaeckerlin/sandbox-base`. Automatic updates, the model list download and the language server downloads are switched off, because the sandbox has no route to the internet.

- `/workspace` — the working directory of the agent; persist it.

### Gateway

| Variable | Default | Description |
| --- | --- | --- |
| `LITELLM_URL` | `http://litellm:4000` | LiteLLM, receives `/v1/…` |
| `HINDSIGHT_URL` | `http://hindsight:8888` | Hindsight, receives `/mcp/…` |
| `LITELLM_API_KEY_FILE` | *(empty)* | File with the LiteLLM key, a Docker secret; a scoped virtual key, never the master key; optional |
| `HINDSIGHT_API_KEY_FILE` | *(empty)* | File with the Hindsight tenant key, a Docker secret; optional |
| `OPENCODE_GATEWAY_PORT` | `8080` | Port of the gateway |

Every key is optional. Without a key file, the gateway forwards the calls of that route without any Authorization header; the placeholder of OpenCode never leaves the gateway.

The gateway forwards `/v1/…` and `/mcp/…` only and answers every other path with 404, a path with a `.` or `..` segment included, so a request cannot leave the route it came in on.

### Ports

The sandbox serves the web interface on port `4096`. [docker-compose.yml](docker-compose.yml) publishes it on every address of the host, IPv4 and IPv6, as long as `BIND_ADDRESS` is unset or empty. `BIND_ADDRESS` limits it to one address of the host: `127.0.0.1` serves the local machine alone, an IPv6 address stands in brackets, such as `[::1]`. `0.0.0.0` publishes on every IPv4 address and on no IPv6 address. The gateway listens on port `8080` for the sandbox only; never publish it.

## Security

- **No key in the sandbox:** the sandbox has neither a key in its environment, nor in its configuration, nor in a file; the end-to-end test searches all three.
- **One way out:** the sandbox network is internal and holds the gateway alone; the test checks that LiteLLM and Hindsight are unreachable from the sandbox.
- **Optional keys and password:** without a key, LiteLLM or Hindsight must accept the gateway without one, and without the server password every client that reaches port 4096 controls the agent. Leave them out only where the network itself decides who reaches each service, such as encrypted Swarm overlay networks that only the services of this stack join; everywhere else set them. The server password lies in the sandbox, so the agent can read it; it opens only the agent's own server.
- **Scoped keys:** the gateway can only pass on the keys it holds. Give it a LiteLLM virtual key limited to the models and the budget of this agent, never the master key.
- **Alert token outside the sandbox:** the sender holds the alert token, the sandbox its SHA-256 digest, so neither the agent nor a copy of the container yields a token that `/alert` accepts. The token allows one thing, a message into the alert session that the model does not answer. The server password would allow the sender everything the web interface allows, the tools of the agent included, which is why `/alert` refuses it.
- **Limitation:** whoever controls the agent can make any model and memory call the keys allow, through the gateway. The split keeps the keys secret; it does not limit what they may do.
- **Limitation:** the text of an alert stands in the alert session; a prompt the user writes in that session later reaches the model together with it.

## Development

```bash
npm test
```

`npm test` runs the docs contract, the compose contract (every published port lies on every address of the host unless `BIND_ADDRESS` names one), the unit tests of the gateway, of the front process and of the plugin against real HTTP servers, the image contract of the headless gateway, and the end-to-end test in [tests/e2e](tests/e2e): a real LiteLLM with a mock model and a master key, the image `mwaeckerlin/hindsight` with a tenant key, the gateway, the sandbox, which answers a prompt and connects both memory banks through the gateway, a second container that delegates a task to the server, with and without the password, a third sandbox with the login link and the alert relay, which takes the Grafana webhook of the Grafana documentation with and without the token, the alerts of a real Alertmanager and a real Grafana, and posts the login link when the subscription model `mysubs/test-model` gets an AuthenticationError from a simulated OpenAI through LiteLLM, and Chromium and Firefox (Playwright in a container), which open the web interface below `/opencode` behind Traefik with ``PathPrefix(`/opencode`)`` and without StripPrefix and at the root, on a network without internet access. The browser tests open Chromium and Firefox through Playwright with fixtures of their own in `tests/e2e/browser/conftest.py`, as the tests of `mwaeckerlin/openclaw` do. The images are published for `linux/amd64` and `linux/arm64` by the reusable workflow of [mwaeckerlin/scratch](https://github.com/mwaeckerlin/scratch#publishing-on-docker-hub).

## Internals

### Base Path Mechanism

OpenCode ships as one compiled Bun executable with its web interface embedded; its documentation names no base path setting, and no module can be loaded ahead of its server. The interface requests its files root-absolute (`/assets/…`), addresses the server through the origin of the page (`/session`, `/global/event`, `/pty/…`), and its router reads `location.pathname` without a base. With `OPENCODE_BASE_PATH`, the entrypoint therefore starts a small front process in Node.js, which the base image carries, and the same process carries the login link and the alert relay:

- **Front process** (`base-path/serve.mjs`): starts `opencode web` on `127.0.0.1:14096` and listens on `OPENCODE_PORT` once OpenCode answers. It takes the base path off every request and websocket upgrade below it, puts it in front of every root-absolute `Location`, and answers the bare path with a 308 to its slash form. Requests outside the base path reach OpenCode unchanged, for the health check and the agents of the stack. It stops with OpenCode, and OpenCode with it.
- **Page and files** (`base-path/configuration.mjs`): below the base path the front process writes `<script src="/opencode/opencode-base-path.js">` as the first element of the head and puts the base path in front of the `src` and `href` of the page, in front of every `url(/…)` of the stylesheets, and makes the icons of the web manifest relative to it. The content security policy of OpenCode allows only scripts of its own origin and its inline theme script, so the browser script is a file of the origin and the theme script keeps its text and its hash.
- **Requests of the bundle** (`base-path/opencode-base-path.js`): the script, loaded before the bundle, takes the base path from its own address and puts it in front of every root-absolute URL of the own origin in `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, workers, `window.open`, `sendBeacon`, the history, the `src`, `href` and `action` of elements, including those the bundle clones from its templates, and, with the Navigation API, a document navigation.
- **Router** (`base-path/patch-upstream.mjs`): the front process gives the router factory of Solid Router the base path when it serves the bundle, so routes, links and navigations of the interface lie below it. The patch matches the code by a pattern that does not depend on the names the minifier chose; a script that carries it more than once answers 502 with file and text. The image build starts the OpenCode of the image, reads its page, bundle and stylesheet, and stops with file and text when the router code is not there exactly once or the page or a stylesheet keeps a root-absolute address the front process does not adjust.

The browser script itself is served without the server password, as it contains nothing but this code. A request below the base path asks OpenCode for plain text, so the front process can adjust the page, the stylesheets and the bundle; a reverse proxy in front may compress them again.

### Login Link and Alerts

The front process also starts when `LITELLM_SUBSCRIPTION_LOGIN_URL` or `OPENCODE_ALERT_TOKEN_SHA256` is set, without a base path too; OpenCode then listens on `127.0.0.1:14096` behind it, and every request outside its own paths reaches OpenCode unchanged.

- **Login link** (`base-path/configuration.mjs`, `base-path/opencode-login-link.css`): the front process writes a bar `<nav id="litellm-subscription-bar">` with the link `<a id="litellm-subscription-login">` as the first element of the body of every page, and a stylesheet of its own origin at the end of the head; the content security policy of OpenCode allows stylesheets of the origin, and the link needs no script. The bar is 1.75rem high above the interface, whose height the stylesheet shortens by as much, so the link covers no tab and no control at any width; a link laid over the window covers the open tab of a session on a phone. Colours and type come from OpenCode's own tokens, so the bar follows the light and the dark scheme. Below a base path the browser script leaves its address as it is (`data-opencode-keep-url`), also where the login page lies on the same host outside the base path. A request of a page at the root asks OpenCode for plain text so the link can be written in; every other request at the root keeps its encoding.
- **Alert relay** (`base-path/serve.mjs`): `/alert`, at the root and below the base path, compares the SHA-256 digest of the bearer token with `OPENCODE_ALERT_TOKEN_SHA256` in constant time, reads at most `OPENCODE_ALERT_MAX_BYTES`, and posts the text to OpenCode's `POST /session/:id/message` with `noReply: true` and the server password. On start it lists the sessions (`GET /session`) and takes the newest top-level session with the title, or creates it (`POST /session`); where OpenCode answers 404 for the session, which it does for a deleted one, it searches again once. OpenCode answers its health check before its first session request, which loads the project and its plugins and took more than 30 seconds in the end-to-end stack, so the search repeats after 1, 2, 5, 10 and 30 seconds and then every minute until OpenCode answers, and the log reports the session once it is found; an alert that arrives meanwhile waits for the same search.
- **Plugin** (`plugin/subscription-login.js`, in the image at `/usr/local/lib/opencode-config/plugins/`, the directory `OPENCODE_CONFIG_DIR` names): OpenCode loads it from there, also read-only. The plugin remembers the model of the last answer of each session from `message.updated` and reacts to `session.error`. Measured with OpenCode 1.19.4 in the image against a LiteLLM that answered 401: `session.error` carries the session and the error, `{"name": "APIError", "data": {"message": "<the message of LiteLLM>", "statusCode": 401, "isRetryable": false, "responseBody": "<the body of LiteLLM>"}}`, and no model; the model stands in the `message.updated` of the answer, which arrives before it. A retryable answer of LiteLLM (500) OpenCode retried five times, over 73 seconds, before `session.error` followed. The plugin posts through the client OpenCode hands it, which also works with a server password, and the message did not start the model. OpenCode calls every export of a plugin file as a plugin, so the file exports the plugin alone.

## Licence

The MIT licence in [LICENSE](LICENSE) covers the files of this repository. OpenCode itself is MIT licensed as well.

[mwaeckerlin/opencode]: https://hub.docker.com/r/mwaeckerlin/opencode "get the image from docker hub"
[OpenCode]: https://opencode.ai
[Hindsight]: https://github.com/mwaeckerlin/hindsight
[mwaeckerlin/sandbox-base]: https://github.com/mwaeckerlin/sandbox-base
