#!/bin/bash
# Starts OpenCode with its web interface. The configuration is written from the
# environment on every start: the models of LiteLLM and the two Hindsight
# memory banks, all reached through the gateway. The sandbox holds no key; the
# placeholder below is what OpenCode sends, and the gateway replaces it.
set -euo pipefail

GATEWAY="${OPENCODE_GATEWAY_URL:-http://opencode-gateway:8080}"
GATEWAY="${GATEWAY%/}"
MODELS="${OPENCODE_MODELS:-}"
SHARED_BANK="${HINDSIGHT_SHARED_BANK:-shared}"
OWN_BANK="${HINDSIGHT_OWN_BANK:-opencode}"
PLACEHOLDER="the-gateway-replaces-this"

# a bank id becomes a path segment of the MCP address
for bank in "${SHARED_BANK}" "${OWN_BANK}"; do
    if [[ ! "${bank}" =~ ^[A-Za-z0-9_-]+$ ]]; then
        echo "opencode: invalid bank id «${bank}»: letters, digits, _ and - only" >&2
        exit 1
    fi
done
if [[ ! "${GATEWAY}" =~ ^https?://[^[:space:]/]+ ]]; then
    echo "opencode: OPENCODE_GATEWAY_URL must be an http or https address, got «${GATEWAY}»" >&2
    exit 1
fi

# OPENCODE_MODELS: comma separated model names of LiteLLM, the first is the default
MODELS_JSON=$(jq -cn --arg list "${MODELS}" \
    '$list | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | map({(.): {name: .}}) | add // {}')
DEFAULT_MODEL=$(jq -rn --arg list "${MODELS}" '$list | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | .[0] // ""')

OPENCODE_CONFIG_CONTENT=$(jq -cn \
    --arg gateway "${GATEWAY}" \
    --arg placeholder "${PLACEHOLDER}" \
    --arg shared "${SHARED_BANK}" \
    --arg own "${OWN_BANK}" \
    --arg model "${DEFAULT_MODEL}" \
    --argjson models "${MODELS_JSON}" \
    '{
        "$schema": "https://opencode.ai/config.json",
        autoupdate: false,
        share: "disabled",
        provider: {
            litellm: {
                npm: "@ai-sdk/openai-compatible",
                name: "LiteLLM",
                options: {baseURL: ($gateway + "/v1"), apiKey: $placeholder},
                models: $models
            }
        },
        mcp: {
            "hindsight-shared": {type: "remote", url: ($gateway + "/mcp/" + $shared + "/"), enabled: true,
                                 headers: {Authorization: ("Bearer " + $placeholder)}},
            "hindsight-own": {type: "remote", url: ($gateway + "/mcp/" + $own + "/"), enabled: true,
                              headers: {Authorization: ("Bearer " + $placeholder)}}
        }
    } + (if $model == "" then {} else {model: ("litellm/" + $model)} end)')
export OPENCODE_CONFIG_CONTENT

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

if [[ "${1:-}" == "--print-config" ]]; then
    echo "${OPENCODE_CONFIG_CONTENT}"
    exit 0
fi

# the web interface by default; any other opencode command when given
if [[ $# -eq 0 ]]; then
    set -- web --hostname 0.0.0.0 --port "${OPENCODE_PORT:-4096}"
fi
exec /usr/local/bin/opencode "$@"
