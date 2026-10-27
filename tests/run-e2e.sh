#!/usr/bin/env bash
# End to end: OpenCode in the sandbox calls the model and the memory through the
# gateway, which adds the keys; the sandbox holds no key and reaches nothing
# but the gateway. The same image serves below the base path /opencode behind
# Traefik without StripPrefix, and Chromium checks it there and at the root.
#
# Usage: tests/run-e2e.sh   (after `npm run build`; needs mwaeckerlin/hindsight)

set -uo pipefail
cd "$(dirname "$0")/e2e"

export OPENCODE_E2E_LITELLM_KEY="e2e-litellm-key-of-the-test-stack"
export OPENCODE_E2E_HINDSIGHT_KEY="e2e-hindsight-key-of-the-test-stack"
export OPENCODE_E2E_SERVER_PASSWORD="e2e-server-password-of-the-test-stack"
COMPOSE=(docker compose -f docker-compose.yml)
PASS=0
FAIL=0

_pass() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
_fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $1: $2"; }

cleanup() { "${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1; }
trap cleanup EXIT
cleanup

wait_healthy() {
    local service="$1" id
    id=$("${COMPOSE[@]}" ps -q "${service}")
    for _ in $(seq 1 120); do
        case "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "${id}" 2>/dev/null)" in
            healthy|running) return 0 ;;
            unhealthy) break ;;
        esac
        sleep 5
    done
    "${COMPOSE[@]}" logs --tail 60 "${service}"
    return 1
}

# LiteLLM has no health check of its own; its readiness endpoint answers once
# the configuration is loaded
wait_litellm() {
    for _ in $(seq 1 60); do
        if "${COMPOSE[@]}" exec -T opencode-gateway /usr/bin/node -e \
            "fetch('http://litellm:4000/health/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2> /dev/null; then
            return 0
        fi
        sleep 3
    done
    "${COMPOSE[@]}" logs --tail 60 litellm
    return 1
}

echo "==> OpenCode end to end"
"${COMPOSE[@]}" build proxy browser || exit 1
"${COMPOSE[@]}" up -d litellm hindsight opencode-gateway opencode-sandbox opencode-base-path proxy || exit 1
wait_healthy hindsight || { _fail "hindsight_healthy" "see log"; exit 1; }
wait_healthy opencode-gateway || { _fail "gateway_healthy" "see log"; exit 1; }
wait_litellm || { _fail "litellm_ready" "see log"; exit 1; }
wait_healthy opencode-sandbox && _pass "sandbox_web_interface_healthy" || _fail "sandbox_web_interface_healthy" "port 4096 does not answer"

SANDBOX=$("${COMPOSE[@]}" ps -q opencode-sandbox)

# the web interface answers the browser with the password, and refuses without
if docker exec "${SANDBOX}" curl -fsS -m 10 -o /dev/null -u "opencode:${OPENCODE_E2E_SERVER_PASSWORD}" http://localhost:4096/; then
    _pass "web_interface_answers_with_password"
else
    _fail "web_interface_answers_with_password" "GET / on port 4096 failed"
fi
STATUS=$(docker exec "${SANDBOX}" curl -s -m 10 -o /dev/null -w '%{http_code}' http://localhost:4096/)
[[ "${STATUS}" == "401" ]] && _pass "web_interface_refuses_without_password" || _fail "web_interface_refuses_without_password" "status ${STATUS}"

# an agent that delegates development attaches to the central server, and the
# model starts working on the task; without the password it is refused
ATTACHED=$("${COMPOSE[@]}" run --rm -e OPENCODE_SERVER_PASSWORD="${OPENCODE_E2E_SERVER_PASSWORD}" delegating-agent \
    run --attach http://opencode-sandbox:4096 --model litellm/test-model "Say hello" 2>&1)
if grep -q "> build · test-model" <<< "${ATTACHED}"; then
    _pass "delegating_agent_attaches"
else
    _fail "delegating_agent_attaches" "$(tail -n 20 <<< "${ATTACHED}")"
fi
REFUSED=$("${COMPOSE[@]}" run --rm delegating-agent \
    run --attach http://opencode-sandbox:4096 --model litellm/test-model "Say hello" 2>&1)
if grep -q "test-model" <<< "${REFUSED}"; then
    _fail "delegation_refused_without_password" "the server took the task without the password"
else
    _pass "delegation_refused_without_password"
fi

# the answer comes back through the server API: one session, one message, and
# the response carries the text of the model
ANSWER=$("${COMPOSE[@]}" run --rm --entrypoint /bin/sh -e OPENCODE_SERVER_PASSWORD="${OPENCODE_E2E_SERVER_PASSWORD}" \
    delegating-agent -c '
        server=http://opencode-sandbox:4096
        auth="opencode:${OPENCODE_SERVER_PASSWORD}"
        session=$(curl -fsS -m 30 -u "${auth}" -X POST -H "Content-Type: application/json" -d "{}" "${server}/session" | jq -r .id) || exit 1
        curl -fsS -m 300 -u "${auth}" -X POST -H "Content-Type: application/json" \
            -d "{\"model\":{\"providerID\":\"litellm\",\"modelID\":\"test-model\"},\"parts\":[{\"type\":\"text\",\"text\":\"Say hello\"}]}" \
            "${server}/session/${session}/message" | jq -r ".parts[] | select(.type == \"text\") | .text"' 2>&1)
if grep -q "Hello from the mock LiteLLM" <<< "${ANSWER}"; then
    _pass "delegating_agent_gets_the_answer_through_the_server_api"
else
    _fail "delegating_agent_gets_the_answer_through_the_server_api" "$(tail -n 20 <<< "${ANSWER}")"
fi

# a prompt reaches the model through the gateway, which adds the LiteLLM key
ANSWER=$(docker exec "${SANDBOX}" /entrypoint.sh run --model litellm/test-model "Say hello" 2>&1)
if grep -q "Hello from the mock LiteLLM" <<< "${ANSWER}"; then
    _pass "prompt_answered_through_gateway"
else
    _fail "prompt_answered_through_gateway" "$(tail -n 20 <<< "${ANSWER}")"
fi

# both memory banks are connected MCP servers
MCP=$(docker exec "${SANDBOX}" /entrypoint.sh mcp list 2>&1)
for server in hindsight-shared hindsight-own; do
    if grep -E "${server}.*(connected|✓)" <<< "${MCP}" > /dev/null; then
        _pass "${server}_connected"
    else
        _fail "${server}_connected" "$(tail -n 20 <<< "${MCP}")"
    fi
done

# the sandbox holds no key: not in its environment, not in its configuration,
# not in any file it can read outside the workspace
for name in litellm hindsight; do
    [[ "${name}" == litellm ]] && key="${OPENCODE_E2E_LITELLM_KEY}" || key="${OPENCODE_E2E_HINDSIGHT_KEY}"
    if docker exec "${SANDBOX}" env | grep -q "${key}"; then
        _fail "no_${name}_key_in_sandbox" "the key stands in the environment"
    elif docker exec "${SANDBOX}" /entrypoint.sh --print-config | grep -q "${key}"; then
        _fail "no_${name}_key_in_sandbox" "the key stands in the configuration"
    elif docker exec "${SANDBOX}" grep -rqs "${key}" /run /etc /home /tmp /workspace 2> /dev/null; then
        _fail "no_${name}_key_in_sandbox" "the key stands in a file"
    else
        _pass "no_${name}_key_in_sandbox"
    fi
done

# the sandbox reaches LiteLLM and Hindsight only through the gateway
for target in litellm=http://litellm:4000/health/readiness hindsight=http://hindsight:8888/health; do
    if docker exec "${SANDBOX}" curl -fsS -m 5 -o /dev/null "${target#*=}" 2> /dev/null; then
        _fail "sandbox_cannot_reach_${target%%=*}" "${target#*=} answered"
    else
        _pass "sandbox_cannot_reach_${target%%=*}"
    fi
done

# a bank id that would change the MCP path stops the start with a message
if OUT=$(docker exec -e HINDSIGHT_OWN_BANK="../v1" "${SANDBOX}" /entrypoint.sh --print-config 2>&1); then
    _fail "invalid_bank_id_stops_the_start" "the start accepted «../v1»"
elif grep -q "invalid bank id" <<< "${OUT}"; then
    _pass "invalid_bank_id_stops_the_start"
else
    _fail "invalid_bank_id_stops_the_start" "${OUT}"
fi

# the gateway refuses every other path
STATUS=$(docker exec "${SANDBOX}" curl -s -m 5 -o /dev/null -w '%{http_code}' http://opencode-gateway:8080/admin)
[[ "${STATUS}" == "404" ]] && _pass "gateway_refuses_other_paths" || _fail "gateway_refuses_other_paths" "status ${STATUS}"

# the same image below the base path /opencode, through its front process
wait_healthy opencode-base-path && _pass "base_path_web_interface_healthy" || _fail "base_path_web_interface_healthy" "port 4096 does not answer"
BASE=$("${COMPOSE[@]}" ps -q opencode-base-path)
LOG=$("${COMPOSE[@]}" logs opencode-base-path)
if grep -q "opencode: serving below /opencode/ on port 4096" <<< "${LOG}"; then
    _pass "serves_below_the_base_path"
else
    _fail "serves_below_the_base_path" "the start did not report the base path"
fi

# the health check and the agents of the stack address the server at the root;
# the base path does not move them
for path in /global/health /opencode/global/health; do
    HEALTH=$(docker exec "${BASE}" curl -fsS -m 10 -u "opencode:${OPENCODE_E2E_SERVER_PASSWORD}" "http://localhost:4096${path}" 2>&1)
    if grep -q '"healthy":true' <<< "${HEALTH}"; then
        _pass "base_path_server_answers_at_${path}"
    else
        _fail "base_path_server_answers_at_${path}" "${HEALTH}"
    fi
done

# a wrong base path stops the start with a message that names the variable
for value in "opencode" "/open code" "/x/../y"; do
    if OUT=$(docker exec -e OPENCODE_BASE_PATH="${value}" "${BASE}" /entrypoint.sh 2>&1); then
        _fail "invalid_base_path_stops_the_start" "the start accepted «${value}»"
    elif grep -q "OPENCODE_BASE_PATH is" <<< "${OUT}"; then
        _pass "invalid_base_path_stops_the_start «${value}»"
    else
        _fail "invalid_base_path_stops_the_start" "${OUT}"
    fi
done

# Chromium below /opencode through Traefik, and at the root
if "${COMPOSE[@]}" run --rm browser pytest -v --tb=short -W error -p no:cacheprovider test_base_path.py test_root.py; then
    _pass "browser_suite"
else
    _fail "browser_suite" "see the pytest output above"
fi

echo ""
echo "==> OpenCode end to end: ${PASS} passed, ${FAIL} failed"
if [[ ${FAIL} -gt 0 ]]; then
    "${COMPOSE[@]}" logs --tail 40 opencode-gateway opencode-sandbox opencode-base-path proxy
    exit 1
fi
