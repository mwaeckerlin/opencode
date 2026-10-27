# Changelog

- 2026-10-27 **1.0.2**
    - The web interface can be served below a path such as `/opencode`, with its page, files, server calls, live updates and terminal connections; the reverse proxy forwards the path unchanged, `/opencode` leads to `/opencode/`, agents of the stack keep reaching the server at its root, and a wrong path stops the start with a message that names the setting

- 2026-10-27 **1.0.1**
    - OpenCode and the configuration from the environment come with `mwaeckerlin/sandbox-base`, so the agents Hermes and OpenClaw run the same release in their own sandboxes; this image runs it as the central server with the web interface, unchanged for its users

- 2026-09-29 **1.0.0**
    - OpenCode with its web interface in a sandbox that holds no key, and a gateway that holds the keys and adds them to every model and memory call
    - Models through LiteLLM and two Hindsight memory banks, one shared with the other agents and one of its own, all configured from the environment
    - One central server for the web interface and for other agents such as Hermes and OpenClaw, which send it development tasks and get the answer back; every key and the server password are optional
    - Published for amd64 and arm64, built, tested and published automatically on every change and every week
