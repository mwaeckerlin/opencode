# Changelog

- 2026-09-29 **1.0.0**
    - OpenCode with its web interface in a sandbox that holds no key, and a gateway that holds the keys and adds them to every model and memory call
    - Models through LiteLLM and two Hindsight memory banks, one shared with the other agents and one of its own, all configured from the environment
    - One central server for the web interface and for other agents such as Hermes and OpenClaw, which send it development tasks and get the answer back; every key and the server password are optional
    - Published for amd64 and arm64, built, tested and published automatically on every change and every week
