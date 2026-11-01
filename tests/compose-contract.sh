#!/usr/bin/env bash
# Compose contract: every port that the compose file and the YAML examples of
# the README publish takes its host address from BIND_ADDRESS. While
# BIND_ADDRESS is unset or empty, the port carries no host address and Docker
# publishes it on every address of the host, IPv4 and IPv6, as a bare
# "8080:8080" does; a set BIND_ADDRESS limits it to that one address.
#
# Usage: tests/compose-contract.sh

set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
declare -a FAILED_NAMES

_pass() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
_fail() { FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); echo "  FAIL  $1: $2"; }

FORM='${BIND_ADDRESS:+${BIND_ADDRESS:-}:}'
COMPOSE=docker-compose.yml

# prints the entries of every `ports:` list of the YAML text on stdin
_ports() {
    awk '
        /^[[:space:]]*ports:[[:space:]]*$/ { match($0, /^[[:space:]]*/); indent = RLENGTH; inside = 1; next }
        inside && /^[[:space:]]*#/ { next }
        inside && /^[[:space:]]*-/ { match($0, /^[[:space:]]*/); if (RLENGTH > indent) { sub(/^[[:space:]]*-[[:space:]]*/, ""); print; next } }
        inside && /^[[:space:]]*$/ { next }
        { inside = 0 }
    '
}

# prints the entries that do not start with the form, quotes removed
_other_form() {
    local entry
    while IFS= read -r entry; do
        entry="${entry#[\"\']}"
        [[ "${entry}" == "${FORM}"* ]] || echo "${entry}"
    done
}

# prints the YAML code blocks of a markdown file
_yaml_blocks() {
    awk '/^```(yaml|yml)/ { inside = 1; next } /^```/ { inside = 0 } inside { print }' "$1"
}

# fails on a published port without the form; `required` fails also when
# nothing is published, so a parser that finds nothing cannot pass
_form() {
    local name="$1" text="$2" required="$3" ports open
    ports=$(_ports <<< "${text}")
    if [[ -z "${ports}" ]]; then
        if [[ "${required}" == required ]]; then
            _fail "${name}" "no published port found"
        else
            _pass "${name} (publishes no port)"
        fi
        return
    fi
    open=$(_other_form <<< "${ports}")
    if [[ -n "${open}" ]]; then
        _fail "${name}" "published without ${FORM}: $(echo ${open})"
    else
        _pass "${name}"
    fi
}

# counts the published ports and the host addresses that `docker compose
# config` renders; the rendered text is never printed, and the empty env file
# keeps a .env of the repository out of it
EMPTY_ENV=$(mktemp)
trap 'rm -f "${EMPTY_ENV}"' EXIT
_rendered() {
    local rendered
    if ! rendered=$("$@" docker compose --env-file "${EMPTY_ENV}" -f "${COMPOSE}" config --format json 2> /dev/null); then
        echo "render-failed"
        return
    fi
    echo "$(grep -o '"published"' <<< "${rendered}" | wc -l) $(grep -o '"host_ip"' <<< "${rendered}" | wc -l) $(grep -o '"host_ip": *"192\.0\.2\.10"' <<< "${rendered}" | wc -l)"
}

echo "==> Compose contract: published ports on every address unless BIND_ADDRESS names one"

_form "docker-compose_ports_bind_address" "$(cat "${COMPOSE}")" required
_form "readme_example_ports_bind_address" "$(_yaml_blocks README.md)" optional

read -r published host_ips _ <<< "$(_rendered env -u BIND_ADDRESS)"
read -r published_empty host_ips_empty _ <<< "$(_rendered env BIND_ADDRESS=)"
if [[ "${published}" == render-failed || "${published_empty}" == render-failed ]]; then
    _fail "docker-compose_rendered_every_address" "docker compose config failed on ${COMPOSE}"
elif [[ "${published}" -gt 0 && "${host_ips}" -eq 0 && "${published_empty}" -eq "${published}" && "${host_ips_empty}" -eq 0 ]]; then
    _pass "docker-compose_rendered_every_address"
else
    _fail "docker-compose_rendered_every_address" "unset: ${published} ports, ${host_ips} host addresses; empty: ${published_empty} ports, ${host_ips_empty} host addresses"
fi

read -r published_set host_ips_set matching <<< "$(_rendered env BIND_ADDRESS=192.0.2.10)"
if [[ "${published_set}" == render-failed ]]; then
    _fail "docker-compose_rendered_bind_address" "docker compose config failed on ${COMPOSE}"
elif [[ "${published_set}" -gt 0 && "${host_ips_set}" -eq "${published_set}" && "${matching}" -eq "${published_set}" ]]; then
    _pass "docker-compose_rendered_bind_address"
else
    _fail "docker-compose_rendered_bind_address" "${published_set} ports, ${matching} of them on 192.0.2.10"
fi

# compose warns about every variable it substitutes without a value, and a
# warning is a failure; the port form gives the inner BIND_ADDRESS a default
WARNINGS=$(env -u BIND_ADDRESS docker compose --env-file "${EMPTY_ENV}" -f "${COMPOSE}" config --format json 2>&1 > /dev/null)
if [[ -z "${WARNINGS}" ]]; then
    _pass "docker-compose_renders_without_warning"
else
    _fail "docker-compose_renders_without_warning" "${WARNINGS}"
fi

# the detection itself: a bare entry and an entry with a fixed default address
# must both be found
if [[ "$(printf 'services:\n  x:\n    ports:\n      - 8080:8080\n      - "${BIND_ADDRESS:-127.0.0.1}:8443:8443"\n      - "${BIND_ADDRESS:+${BIND_ADDRESS:-}:}80:8080"\n' | _ports | _other_form | wc -l)" -eq 2 ]]; then
    _pass "selftest_fixed_address_detected"
else
    _fail "selftest_fixed_address_detected" "an entry without ${FORM} was not found"
fi

echo ""
echo "==> Compose contract results: ${PASS} passed, ${FAIL} failed"
if [[ ${FAIL} -gt 0 ]]; then
    echo "==> Failed contracts: ${FAILED_NAMES[*]}"
    exit 1
fi
