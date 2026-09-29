# Tests

Register of all tests, sorted by the [FEATURES.md](FEATURES.md) number each test covers. `npm test` runs everything, locally and in the pipeline. The guard `tests/docs-contract.sh` fails when a feature has no test entry here or a test carries a skip marker.

## Unit

`npm run test:unit` runs `gateway/gateway.test.mjs` against real HTTP servers standing in for LiteLLM and Hindsight.

- **F5** `gateway/gateway.test.mjs` › model call reaches LiteLLM with the real key instead of the placeholder, memory call reaches Hindsight with the Hindsight key, the LiteLLM key never reaches Hindsight and the other way round, a stream arrives as a stream.
- **F6** `gateway/gateway.test.mjs` › every other path is refused, a dot segment cannot leave the route it came in on, health answers from the gateway itself.
- **F7** `gateway/gateway.test.mjs` › an unreachable upstream answers 502 and names it, a missing or empty key file stops the start and names it, an upstream address must be http or https.

## End-to-end

`npm run test:e2e` starts `tests/e2e/docker-compose.yml`: a real LiteLLM with a mock model that demands its master key, the image `mwaeckerlin/hindsight` with a tenant key, the gateway with both keys, and the sandbox without any.

- **F1** `tests/run-e2e.sh` › sandbox_web_interface_healthy, web_interface_answers_with_password.
- **F2** `tests/run-e2e.sh` › prompt_answered_through_gateway — the mock answer arrives only when the gateway added the LiteLLM master key.
- **F3** `tests/run-e2e.sh` › hindsight-shared_connected, hindsight-own_connected.
- **F4** `tests/run-e2e.sh` › no_litellm_key_in_sandbox, no_hindsight_key_in_sandbox: neither key in the environment, the configuration or a file of the sandbox.
- **F6** `tests/run-e2e.sh` › sandbox_cannot_reach_litellm, sandbox_cannot_reach_hindsight, gateway_refuses_other_paths.
- **F7** `tests/run-e2e.sh` › the sandbox refuses an invalid bank id at start (`invalid_bank_id_stops_the_start`).
- **F10** `tests/run-e2e.sh` › delegating_agent_gets_the_answer_through_the_server_api: a second container on a network of its own opens a session on the central server, posts a task and reads the text of the answer from the response; delegating_agent_attaches: the same container hands a task over with `opencode run --attach`, and the model starts on it.
- **F11** `tests/run-e2e.sh` › web_interface_answers_with_password, web_interface_refuses_without_password, delegation_refused_without_password.
- **F12** `gateway/gateway.test.mjs` › without a key file the call goes out without any key, the placeholder removed.

## Image contract

- **F8** `tests/image-contract.sh` › no sh, no bash, no busybox, no perl in `mwaeckerlin/opencode:gateway`.

## Workflow contract

- **F9** `tests/workflow-contract.sh` of `mwaeckerlin/scratch` — the reusable workflow selects exactly the images a repository publishes; this repository calls it from `.github/workflows/docker.yml`.
