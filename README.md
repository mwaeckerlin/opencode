# OpenCode Docker Images

[mwaeckerlin/opencode] runs [OpenCode], the open source coding agent, as a server with its web interface, split into two images so that the agent never holds a key:

- **`mwaeckerlin/opencode:sandbox`** — OpenCode with its web interface and the full toolset of [mwaeckerlin/sandbox-base]. OpenCode runs its tools (bash, edit, write) in the same process that talks to the model, so this container holds no secret at all.
- **`mwaeckerlin/opencode:gateway`** — the only container with keys. It forwards the model calls of the sandbox to LiteLLM and its memory calls to [Hindsight], and replaces the Authorization header with the real key, read from a Docker secret.

The sandbox reaches nothing but its gateway. OpenCode sends a placeholder where it expects a key; the end-to-end test measures that the real keys never reach the sandbox.

All features are listed in [FEATURES.md](FEATURES.md), all tests in [TESTS.md](TESTS.md).

## Usage

[docker-compose.yml](docker-compose.yml) shows the split: the sandbox on an internal network with the gateway only, the gateway also on the network of LiteLLM and Hindsight. Browse to port 4096 of the sandbox; behind a reverse proxy, put an authentication in front of it, since whoever reaches the web interface controls the agent.

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

## Administration

### Sandbox

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_GATEWAY_URL` | `http://opencode-gateway:8080` | Address of the gateway |
| `OPENCODE_MODELS` | *(empty)* | Comma separated model names of LiteLLM; the first one is the default model |
| `HINDSIGHT_SHARED_BANK` | `shared` | Memory bank shared by all agents, MCP server `hindsight-shared` |
| `HINDSIGHT_OWN_BANK` | `opencode` | Memory bank of OpenCode alone, MCP server `hindsight-own` |
| `OPENCODE_PORT` | `4096` | Port of the web interface |
| `OPENCODE_SERVER_PASSWORD_FILE` | *(empty)* | File with the password of the server, a Docker secret; optional: with it, the web interface and every attaching agent need the password (user `opencode`), without it the server is open to whoever reaches port 4096 |

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

## Security

- **No key in the sandbox:** the sandbox has neither a key in its environment, nor in its configuration, nor in a file; the end-to-end test searches all three.
- **One way out:** the sandbox network is internal and holds the gateway alone; the test checks that LiteLLM and Hindsight are unreachable from the sandbox.
- **Optional keys and password:** without a key, LiteLLM or Hindsight must accept the gateway without one, and without the server password every client that reaches port 4096 controls the agent. Leave them out only where the network itself decides who reaches each service, such as encrypted Swarm overlay networks that only the services of this stack join; everywhere else set them. The server password lies in the sandbox, so the agent can read it; it opens only the agent's own server.
- **Scoped keys:** the gateway can only pass on the keys it holds. Give it a LiteLLM virtual key limited to the models and the budget of this agent, never the master key.
- **Limitation:** whoever controls the agent can make any model and memory call the keys allow, through the gateway. The split keeps the keys secret; it does not limit what they may do.

## Development

```bash
npm test
```

`npm test` runs the docs contract, the unit tests of the gateway against real HTTP servers, the image contract of the headless gateway, and the end-to-end test in [tests/e2e](tests/e2e): a real LiteLLM with a mock model and a master key, the image `mwaeckerlin/hindsight` with a tenant key, the gateway, the sandbox, which answers a prompt and connects both memory banks through the gateway, and a second container that delegates a task to the server, with and without the password. The images are published for `linux/amd64` and `linux/arm64` by the reusable workflow of [mwaeckerlin/scratch](https://github.com/mwaeckerlin/scratch#publishing-on-docker-hub).

## Licence

The MIT licence in [LICENSE](LICENSE) covers the files of this repository. OpenCode itself is MIT licensed as well.

[mwaeckerlin/opencode]: https://hub.docker.com/r/mwaeckerlin/opencode "get the image from docker hub"
[OpenCode]: https://opencode.ai
[Hindsight]: https://github.com/mwaeckerlin/hindsight
[mwaeckerlin/sandbox-base]: https://github.com/mwaeckerlin/sandbox-base
