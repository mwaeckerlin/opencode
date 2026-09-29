# Features

Numbered register of every feature; a number is never reused. Every feature is covered by tests listed in [TESTS.md](TESTS.md); the guard `tests/docs-contract.sh` fails when a feature has no test.

- **F1 — OpenCode in the browser.** The sandbox runs OpenCode with its web interface on port 4096, in the working directory `/workspace`, with the full toolset of `mwaeckerlin/sandbox-base`.
- **F2 — Models through LiteLLM.** `OPENCODE_MODELS` names the LiteLLM models OpenCode offers, the first as its default; every model call goes through the gateway.
- **F3 — Two memory banks.** OpenCode reaches the bank shared by all agents and a bank of its own as the MCP servers `hindsight-shared` and `hindsight-own`, through the gateway.
- **F4 — No key in the sandbox.** Neither the environment, nor the configuration, nor any file of the sandbox holds a key; OpenCode sends a placeholder.
- **F5 — The gateway adds the keys.** The gateway replaces the Authorization header with the LiteLLM key on `/v1/…` and the Hindsight key on `/mcp/…`, each read from a Docker secret, and streams the answer back.
- **F6 — One way out.** The sandbox reaches only its gateway; the gateway answers every path except `/v1/…`, `/mcp/…` and `/health` with 404, a path with a dot segment included.
- **F7 — Clear start errors.** A missing or empty key file, an upstream address that is not http or https, an unreachable upstream (502) and an invalid bank id each stop or answer with a message that names the cause.
- **F8 — Headless gateway.** The gateway image contains no shell, no busybox and no perl.
- **F9 — Published for amd64 and arm64.** Every push builds both images natively for both architectures and publishes them on Docker Hub, with the reusable workflow of `mwaeckerlin/scratch`.
- **F10 — Development agent for other agents.** One central OpenCode server serves the web interface and the agents that delegate development to it, such as Hermes and OpenClaw: they send a task through the server API and get the answer back in the response, or hand it over with `opencode run --attach`.
- **F11 — Optional server password.** With `OPENCODE_SERVER_PASSWORD_FILE`, the web interface and every attaching agent need the password; without it the server is open.
- **F12 — Optional keys.** Without a key file, the gateway forwards that route without any Authorization header, for a deployment whose network decides who reaches LiteLLM and Hindsight.
