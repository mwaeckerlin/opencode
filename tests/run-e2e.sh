#!/usr/bin/env bash
# End to end: OpenCode in the sandbox calls the model and the memory through the
# gateway, which adds the keys; the sandbox holds no key and reaches nothing
# but the gateway. The same image serves below the base path /opencode behind
# Traefik without StripPrefix, and Chromium checks it there and at the root.
# A third sandbox at the root carries the login link, takes alerts of a real
# Alertmanager and a real Grafana into its alert session, and posts the login
# link when a subscription model fails at a simulated OpenAI.
#
# Usage: tests/run-e2e.sh   (after `npm run build`; needs mwaeckerlin/hindsight)

set -uo pipefail
# the default webhook payload of the Grafana documentation
GRAFANA_ALERT=$(< "$(dirname "$(dirname "$0")")/base-path/fixtures/grafana-webhook.json")
cd "$(dirname "$0")/e2e"

export OPENCODE_E2E_LITELLM_KEY="e2e-litellm-key-of-the-test-stack"
export OPENCODE_E2E_HINDSIGHT_KEY="e2e-hindsight-key-of-the-test-stack"
export OPENCODE_E2E_SERVER_PASSWORD="e2e-server-password-of-the-test-stack"
# Alertmanager and Grafana hold the token, the sandboxes only its digest
export OPENCODE_E2E_ALERT_TOKEN="e2e-alert-token-of-the-test-stack"
ALERT_TOKEN="${OPENCODE_E2E_ALERT_TOKEN}"
OPENCODE_E2E_ALERT_TOKEN_SHA256=$(printf '%s' "${ALERT_TOKEN}" | sha256sum | cut -d ' ' -f 1)
export OPENCODE_E2E_ALERT_TOKEN_SHA256
export OPENCODE_E2E_GRAFANA_PASSWORD="e2e-grafana-password-of-the-test-stack"
LOGIN_URL="http://proxy:8080/litellm/mysubs"
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
"${COMPOSE[@]}" up -d litellm openai-simulated hindsight opencode-gateway opencode-sandbox opencode-base-path opencode-subscription proxy alertmanager grafana || exit 1
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

# the sandbox with the login link and the alert relay
wait_healthy opencode-subscription && _pass "subscription_web_interface_healthy" || _fail "subscription_web_interface_healthy" "port 4096 does not answer"
SUBSCRIPTION=$("${COMPOSE[@]}" ps -q opencode-subscription)
AUTH="opencode:${OPENCODE_E2E_SERVER_PASSWORD}"

# the server API of a sandbox, from inside it, with the server password
api() {
    docker exec "$1" curl -fsS -m "${4:-30}" -u "${AUTH}" -X "$2" -H "Content-Type: application/json" ${5:+-d "$5"} "http://localhost:4096$3"
}

# the id of the alert session, as the server lists it
alert_session() {
    api "$1" GET /session | jq -r '[.[] | select(.title == "Alerts" and (.parentID == null))] | sort_by(.time.updated) | last | .id // empty'
}

# whether a text part of a session carries a text
session_says() {
    api "$1" GET "/session/$2/message" | jq -e --arg text "$3" '[.[].parts[] | select(.type == "text") | .text | contains($text)] | any' > /dev/null
}

# the front process reports the alert session once OpenCode answers its first
# session request, the n-th time after the n-th start; OpenCode answered that
# request only after more than 30s in this stack, so the check repeats for at
# most 300s, a bound for a loaded machine
alert_session_reported() {
    for _ in $(seq 1 300); do
        LOG=$("${COMPOSE[@]}" logs opencode-subscription)
        [[ "$(grep -c "opencode: alerts on /alert go to the session" <<< "${LOG}")" -ge "$1" ]] && return 0
        sleep 1
    done
    return 1
}

# the session exists from the start, before the first alert
alert_session_reported 1
FIRST_SESSION=$(alert_session "${SUBSCRIPTION}")
if [[ -n "${FIRST_SESSION}" ]] && grep -q "opencode: alerts on /alert go to the session ${FIRST_SESSION} «Alerts»" <<< "${LOG}"; then
    _pass "alert_session_exists_from_the_start"
else
    _fail "alert_session_exists_from_the_start" "session «${FIRST_SESSION}», log: $(grep 'opencode:' <<< "${LOG}" | tail -n 5)"
fi

# an alert as Grafana sends it, with and without the token; the answer is the
# status of the relay, the body of the alert comes from standard input
send_alert() {
    "${COMPOSE[@]}" run --rm -T alert-sender -s -o /dev/null -w '%{http_code}' -m 30 -X POST \
        -H "Content-Type: application/json" "$@" --data-binary @- "http://opencode-subscription:4096/alert" <<< "${GRAFANA_ALERT}"
}
STATUS=$(send_alert)
[[ "${STATUS}" == "401" ]] && _pass "alert_refused_without_token" || _fail "alert_refused_without_token" "status ${STATUS}"
STATUS=$(send_alert -H "Authorization: Bearer not-the-alert-token")
[[ "${STATUS}" == "401" ]] && _pass "alert_refused_with_a_wrong_token" || _fail "alert_refused_with_a_wrong_token" "status ${STATUS}"
STATUS=$(send_alert -H "Authorization: Basic $(printf '%s' "${AUTH}" | base64 -w 0)")
[[ "${STATUS}" == "401" ]] && _pass "alert_refused_with_the_server_password" || _fail "alert_refused_with_the_server_password" "status ${STATUS}"
if session_says "${SUBSCRIPTION}" "${FIRST_SESSION}" "alertname = T2"; then
    _fail "refused_alerts_reach_no_session" "a refused alert stands in the session"
else
    _pass "refused_alerts_reach_no_session"
fi
STATUS=$(send_alert -H "Authorization: Bearer ${ALERT_TOKEN}")
[[ "${STATUS}" == "200" ]] && _pass "alert_taken_with_token" || _fail "alert_taken_with_token" "status ${STATUS}"

# the alert stands in the alert session with the login link, and the model
# did not answer it
MESSAGES=$(api "${SUBSCRIPTION}" GET "/session/${FIRST_SESSION}/message")
if jq -e --arg login "${LOGIN_URL}" '[.[].parts[] | select(.type == "text") | .text]
        | any(startswith("[FIRING:2]  (blue)") and contains("alertname = T2") and endswith("Sign in to the subscriptions again: " + $login))' <<< "${MESSAGES}" > /dev/null; then
    _pass "alert_stands_in_the_alert_session_with_the_login_link"
else
    _fail "alert_stands_in_the_alert_session_with_the_login_link" "$(head -c 2000 <<< "${MESSAGES}")"
fi
if jq -e '[.[] | select(.info.role == "assistant")] | length == 0' <<< "${MESSAGES}" > /dev/null; then
    _pass "alert_gets_no_answer_of_the_model"
else
    _fail "alert_gets_no_answer_of_the_model" "$(head -c 2000 <<< "${MESSAGES}")"
fi

# the alert token stands nowhere in the sandbox: not in its environment, not
# in a file it can read outside the session data that carries the alert text
for container in "${SUBSCRIPTION}" "${BASE}"; do
    if docker exec "${container}" env | grep -q "${ALERT_TOKEN}"; then
        _fail "no_alert_token_in_sandbox" "the token stands in the environment of ${container:0:12}"
    elif docker exec "${container}" grep -rqs "${ALERT_TOKEN}" /run /etc /home /tmp /workspace /usr/local/lib 2> /dev/null; then
        _fail "no_alert_token_in_sandbox" "the token stands in a file of ${container:0:12}"
    else
        _pass "no_alert_token_in_sandbox"
    fi
done

# after a restart the image finds its alert session again
"${COMPOSE[@]}" restart opencode-subscription > /dev/null
wait_healthy opencode-subscription || _fail "subscription_web_interface_healthy_after_restart" "port 4096 does not answer"
alert_session_reported 2 || _fail "alert_session_reported_after_restart" "$(grep 'opencode:' <<< "${LOG}" | tail -n 5)"
STATUS=$(send_alert -H "Authorization: Bearer ${ALERT_TOKEN}")
SESSIONS=$(api "${SUBSCRIPTION}" GET /session | jq '[.[] | select(.title == "Alerts")] | length')
if [[ "${STATUS}" == "200" && "$(alert_session "${SUBSCRIPTION}")" == "${FIRST_SESSION}" && "${SESSIONS}" == "1" ]]; then
    _pass "alert_session_found_again_after_restart"
else
    _fail "alert_session_found_again_after_restart" "status ${STATUS}, ${SESSIONS} sessions «Alerts», first ${FIRST_SESSION}, now $(alert_session "${SUBSCRIPTION}")"
fi

# an alert session that carries a text; the senders deliver on their own
# schedule, so the check repeats for at most 60s, a bound for a loaded machine
alert_arrives() {
    for _ in $(seq 1 60); do
        session_says "${SUBSCRIPTION}" "$(alert_session "${SUBSCRIPTION}")" "$1" && return 0
        sleep 1
    done
    return 1
}
# the request of a sender on the network of Alertmanager and Grafana; prints
# the body of the answer, then its status
sender() {
    "${COMPOSE[@]}" run --rm -T alert-sender -sS -m 60 -w '\n%{http_code}' "$@"
}

# Alertmanager sends an alert it received to the relay, with the token from
# its file; it reaches the alert session with the login link
AM_ALERT="SubscriptionModelFailing-e2e"
AM_STATUS=$(sender -X POST -H "Content-Type: application/json" \
    -d "[{\"labels\":{\"alertname\":\"${AM_ALERT}\",\"model_group\":\"mysubs/test-model\"},\"annotations\":{\"summary\":\"mysubs/test-model fails its requests\"}}]" \
    http://alertmanager:9093/api/v2/alerts | tail -n 1)
if [[ "${AM_STATUS}" == "200" ]] && alert_arrives "- firing: ${AM_ALERT}: mysubs/test-model fails its requests" \
        && session_says "${SUBSCRIPTION}" "$(alert_session "${SUBSCRIPTION}")" "Sign in to the subscriptions again: ${LOGIN_URL}"; then
    _pass "alertmanager_alert_reaches_the_alert_session"
else
    _fail "alertmanager_alert_reaches_the_alert_session" "status ${AM_STATUS}; $("${COMPOSE[@]}" logs --tail 20 alertmanager 2>&1)"
fi

# Grafana tests a webhook contact point with the token, the call its own form
# makes; the alert reaches the alert session, and a wrong token is refused
for _ in $(seq 1 60); do
    sender -u "admin:${OPENCODE_E2E_GRAFANA_PASSWORD}" http://grafana:3000/api/health | grep -q '"database": *"ok"' && break
    sleep 2
done
grafana_test() {
    sender -u "admin:${OPENCODE_E2E_GRAFANA_PASSWORD}" -X POST -H "Content-Type: application/json" \
        -d "{\"integration\":{\"type\":\"webhook\",\"settings\":{\"url\":\"http://opencode-subscription:4096/alert\",\"httpMethod\":\"POST\",\"authorization_scheme\":\"Bearer\",\"authorization_credentials\":\"$1\"},\"disableResolveMessage\":false},\"alert\":{\"labels\":{\"alertname\":\"$2\",\"model_group\":\"mysubs/test-model\"},\"annotations\":{\"summary\":\"Grafana reached the alert session\"}}}" \
        http://grafana:3000/apis/notifications.alerting.grafana.app/v1beta1/namespaces/default/receivers/-/test
}
GRAFANA_ANSWER=$(grafana_test "${ALERT_TOKEN}" GrafanaSubscriptionCheck-e2e)
if jq -e '.status == "success"' <<< "$(sed '$d' <<< "${GRAFANA_ANSWER}")" > /dev/null && alert_arrives "GrafanaSubscriptionCheck-e2e"; then
    _pass "grafana_contact_point_reaches_the_alert_session"
else
    _fail "grafana_contact_point_reaches_the_alert_session" "${GRAFANA_ANSWER}"
fi
GRAFANA_ANSWER=$(grafana_test "not-the-alert-token" GrafanaWrongToken-e2e)
if jq -e '.status == "failure" and (.error | contains("401"))' <<< "$(sed '$d' <<< "${GRAFANA_ANSWER}")" > /dev/null; then
    _pass "grafana_contact_point_with_a_wrong_token_is_refused"
else
    _fail "grafana_contact_point_with_a_wrong_token_is_refused" "${GRAFANA_ANSWER}"
fi

# below the base path, through the proxy, the relay of the second sandbox
BASE_ALERT=$("${COMPOSE[@]}" run --rm -T -e ALERT_TOKEN="${ALERT_TOKEN}" --entrypoint /opt/venv/bin/python browser -c '
import os, sys, requests
answer = requests.post("http://proxy:8080/opencode/alert", data=sys.stdin.buffer.read(), timeout=30,
                       headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["ALERT_TOKEN"]})
print(answer.status_code)' <<< "${GRAFANA_ALERT}" 2>&1)
if [[ "${BASE_ALERT}" == "200" ]] && session_says "${BASE}" "$(alert_session "${BASE}")" "alertname = T2"; then
    _pass "alert_taken_below_the_base_path"
else
    _fail "alert_taken_below_the_base_path" "${BASE_ALERT}"
fi

# a failed subscription model gets the login link in its session; the plugin
# posts it on session.error, which OpenCode sends with the failed answer, so
# the check repeats for at most 30s, a bound for a loaded machine. A failing
# model outside the subscriptions and a model that answers are asked first:
# the plugin handles the events in their order, so once the link of the
# subscription model stands, a link for either of them would stand as well.
prompt_session() {
    local session
    session=$(api "${SUBSCRIPTION}" POST /session 30 '{}' | jq -r .id) || return 1
    api "${SUBSCRIPTION}" POST "/session/${session}/message" 300 \
        "{\"model\":{\"providerID\":\"litellm\",\"modelID\":\"$1\"},\"parts\":[{\"type\":\"text\",\"text\":\"Say hello\"}]}" > /dev/null
    echo "${session}"
}
link_posted() {
    for _ in $(seq 1 30); do
        session_says "${SUBSCRIPTION}" "$1" "Sign in to the subscriptions again: ${LOGIN_URL}" && return 0
        sleep 1
    done
    return 1
}
declare -A OTHER
for model in broken-model test-model; do
    OTHER[${model}]=$(prompt_session "${model}")
done
FAILED=$(prompt_session mysubs/test-model)
if [[ -n "${FAILED}" ]] && link_posted "${FAILED}" && session_says "${SUBSCRIPTION}" "${FAILED}" "The subscription model mysubs/test-model failed: "; then
    _pass "failed_subscription_model_gets_the_login_link"
else
    _fail "failed_subscription_model_gets_the_login_link" "$(api "${SUBSCRIPTION}" GET "/session/${FAILED}/message" | head -c 2000)"
fi
# the failure is LiteLLM's own answer, and the model did not answer the link
if api "${SUBSCRIPTION}" GET "/session/${FAILED}/message" | jq -e '[.[] | select(.info.role == "assistant")]
        | length == 1 and (.[0].info.error.data.statusCode == 401) and (.[0].info.error.data.message | test("AuthenticationError"))' > /dev/null; then
    _pass "subscription_failure_is_the_answer_of_litellm"
else
    _fail "subscription_failure_is_the_answer_of_litellm" "$(api "${SUBSCRIPTION}" GET "/session/${FAILED}/message" | head -c 2000)"
fi
# a failing model outside the subscriptions, and a model that answers, get none
for model in broken-model test-model; do
    SESSION="${OTHER[${model}]}"
    if [[ -z "${SESSION}" ]]; then
        _fail "no_login_link_for_${model}" "the session did not answer"
    elif session_says "${SUBSCRIPTION}" "${SESSION}" "Sign in to the subscriptions again"; then
        _fail "no_login_link_for_${model}" "the login link was posted"
    else
        _pass "no_login_link_for_${model}"
    fi
done
# the failure of broken-model was a failure, so its missing link says something
if api "${SUBSCRIPTION}" GET "/session/${OTHER[broken-model]}/message" | jq -e '[.[] | select(.info.role == "assistant" and .info.error != null)] | length == 1' > /dev/null; then
    _pass "broken_model_failed"
else
    _fail "broken_model_failed" "the answer of broken-model carries no error"
fi

# Chromium below /opencode through Traefik, and at the root; the login link in
# Chromium and Firefox
if "${COMPOSE[@]}" run --rm -e ENGINES=chromium browser /opt/venv/bin/pytest -v --tb=short -W error -p no:cacheprovider test_base_path.py test_root.py; then
    _pass "browser_suite"
else
    _fail "browser_suite" "see the pytest output above"
fi
if "${COMPOSE[@]}" run --rm -e ENGINES=chromium,firefox browser /opt/venv/bin/pytest -v --tb=short -W error -p no:cacheprovider test_login_link.py; then
    _pass "browser_login_link"
else
    _fail "browser_login_link" "see the pytest output above"
fi

echo ""
echo "==> OpenCode end to end: ${PASS} passed, ${FAIL} failed"
if [[ ${FAIL} -gt 0 ]]; then
    "${COMPOSE[@]}" logs --tail 40 opencode-gateway opencode-sandbox opencode-base-path opencode-subscription proxy
    exit 1
fi
