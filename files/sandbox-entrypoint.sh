#!/bin/bash
# Starts OpenCode with its web interface. The command `opencode` of
# mwaeckerlin/sandbox-base writes the configuration from the environment on
# every start: the models of LiteLLM and the two Hindsight memory banks, all
# reached through the gateway. The sandbox holds no key; the gateway adds them.
set -euo pipefail

# Optional password of the server, from a Docker secret: the web interface and
# every agent that attaches (`opencode run --attach`) then need it. Without it
# the server is open to everybody who reaches its port.
if [[ -n "${OPENCODE_SERVER_PASSWORD_FILE:-}" ]]; then
    if [[ -n "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
        echo "opencode: OPENCODE_SERVER_PASSWORD and OPENCODE_SERVER_PASSWORD_FILE are both set; set one of them" >&2
        exit 1
    fi
    if [[ ! -r "${OPENCODE_SERVER_PASSWORD_FILE}" ]]; then
        echo "opencode: OPENCODE_SERVER_PASSWORD_FILE names ${OPENCODE_SERVER_PASSWORD_FILE}, which cannot be read" >&2
        exit 1
    fi
    OPENCODE_SERVER_PASSWORD="$(< "${OPENCODE_SERVER_PASSWORD_FILE}")"
    OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD%$'\n'}"
    if [[ -z "${OPENCODE_SERVER_PASSWORD}" ]]; then
        echo "opencode: OPENCODE_SERVER_PASSWORD_FILE names ${OPENCODE_SERVER_PASSWORD_FILE}, which is empty" >&2
        exit 1
    fi
    export OPENCODE_SERVER_PASSWORD
    unset OPENCODE_SERVER_PASSWORD_FILE
fi

# the web interface by default; any other opencode command, and
# --print-config, when given
if [[ $# -eq 0 ]]; then
    set -- web --hostname 0.0.0.0 --port "${OPENCODE_PORT:-4096}"
fi
exec /usr/local/bin/opencode "$@"
