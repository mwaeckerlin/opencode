# Tests

Register of all tests, sorted by the [FEATURES.md](FEATURES.md) number each test covers. `npm test` runs everything, locally and in the pipeline. The guard `tests/docs-contract.sh` fails when a feature has no test entry here or a test carries a skip marker.

## End-to-end frontend

`npm run test:e2e` runs `tests/e2e/browser` (pytest with Playwright, Chromium in a container) against the sandbox below `/opencode` behind Traefik with ``PathPrefix(`/opencode`)`` and without StripPrefix, and against the same image at the root, on a network without internet access.

- **F13** `tests/e2e/browser/test_base_path.py` › test_bare_base_path_redirects_to_its_slash_form — `/opencode` and `/opencode?x=%2F` answer 308 to their slash form.
- **F13** `tests/e2e/browser/test_base_path.py` › test_the_page_names_its_files_below_the_base_path — the browser script comes before the bundle, every file of the page lies below `/opencode`.
- **F13** `tests/e2e/browser/test_base_path.py` › test_nothing_outside_the_base_path_is_routed — the proxy answers 404 outside `/opencode`.
- **F11, F13** `tests/e2e/browser/test_base_path.py` › test_the_server_password_holds_below_the_base_path — page and API below `/opencode` answer 401 without the password.
- **F1, F13** `tests/e2e/browser/test_base_path.py` › test_page_renders_and_every_request_stays_below_the_base_path — Chromium draws the interface, every request of the page stays below `/opencode`, bundle and stylesheet load, no request fails, the server API answers.
- **F13** `tests/e2e/browser/test_base_path.py` › test_the_router_lands_where_it_lands_at_the_root — the interface below `/opencode` lands on the same route as at the root, with the base path in front.
- **F13** `tests/e2e/browser/test_base_path.py` › test_document_names_no_url_outside_the_base_path — no element of the drawn page names a root-absolute address outside `/opencode`.
- **F13** `tests/e2e/browser/test_base_path.py` › test_deep_link_serves_the_page_below_the_base_path — a deep link serves the page with its files below `/opencode`.
- **F13** `tests/e2e/browser/test_base_path.py` › test_stylesheet_and_manifest_name_their_files_below_the_base_path — the fonts of the stylesheet and the icons of the web manifest lie below `/opencode`.
- **F13** `tests/e2e/browser/test_base_path.py` › test_fetch_xhr_and_event_source_of_root_absolute_api_stay_below_the_base_path — fetch in four forms, XMLHttpRequest and EventSource of a root-absolute address reach the server below `/opencode`.
- **F13** `tests/e2e/browser/test_base_path.py` › test_websocket_of_the_page_opens_below_the_base_path — a websocket of the page connects below `/opencode`.
- **F13** `tests/e2e/browser/test_base_path.py` › test_websocket_upgrade_reaches_opencode_only_below_the_base_path — an upgrade below `/opencode` gets OpenCode's password challenge, one outside gets 404 from the proxy.
- **F13** `tests/e2e/browser/test_base_path.py` › test_links_history_and_windows_keep_the_base_path — links, attributes, images, the history and `window.open` keep the base path.
- **F13** `tests/e2e/browser/test_base_path.py` › test_document_navigation_to_a_root_absolute_address_stays_below_the_base_path — `location.href = '/…'` goes below `/opencode`.
- **F13** `tests/e2e/browser/test_base_path.py` › test_foreign_relative_and_prefixed_urls_stay_unchanged — foreign, protocol-relative, relative, data, fragment and prefixed addresses stay as they are.
- **F1, F13** `tests/e2e/browser/test_root.py` › test_the_page_names_its_files_at_the_root, test_page_renders_at_the_root — without the base path the same image serves the interface at the root, without the browser script and without a request to `/opencode`.

## Unit

`npm run test:unit` runs `gateway/gateway.test.mjs` against real HTTP servers standing in for LiteLLM and Hindsight, and `base-path/*.test.mjs` against real HTTP servers standing in for OpenCode, with the page and the web manifest OpenCode 1.19.4 serves and the router code cut from its bundle (`base-path/fixtures`).

- **F13** `base-path/configuration.test.mjs` › the base path is a path, unset, empty or / is the root; a base path that is no path stops the start and names the variable; the port of the front process is a port other than the one of OpenCode behind it; a request below the base path loses the base path, the bare base path goes to its slash form; a root-absolute redirect gets the base path, any other stays; the page loads the browser script first and names its files below the base path; a protocol-relative, foreign or relative URL of the page stays; the stylesheet names its fonts below the base path; the web manifest names its icons and its start relative to itself.
- **F13** `base-path/patch-upstream.test.mjs` › the router factory takes the base path of the browser script when the application passes none; the patch does not depend on the names the minifier chose; a script without the router stays as it is, the code twice stops with file and text; the build check passes on the interface of OpenCode; the build check stops when upstream changed the router, the page or the stylesheet.
- **F13** `base-path/serve.test.mjs` › below the base path OpenCode sees the path of its own routes, outside it sees the path as it is; the bare base path redirects to its slash form, with the query; a root-absolute redirect below the base path keeps the base path, a foreign one and one at the root stay; the page below the base path loads the browser script first and keeps its security policy; the browser script is served below the base path; the bundle gives its router the base path, the stylesheet its fonts and the manifest its icons; below the base path OpenCode is asked for plain text, at the root the client decides; a bundle with the router code twice answers 502 and names file and text; the event stream arrives while it is open; a websocket below the base path reaches OpenCode with the path of its routes and carries data both ways; an OpenCode that does not answer gives 502 with its address; only page, stylesheet, script and manifest are adjusted; the front process starts OpenCode behind it and serves it below the base path; with / as base path OpenCode itself listens on the port, at the root; a wrong setting stops the start with a message that names it.

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
- **F13** `tests/run-e2e.sh` › base_path_web_interface_healthy, serves_below_the_base_path; base_path_server_answers_at_/global/health and at_/opencode/global/health: the agents inside the stack reach the server at the root as well; invalid_base_path_stops_the_start for `opencode`, `/open code` and `/x/../y`; browser_suite runs the browser tests above.

## Image build

- **F13** `Dockerfile.sandbox` › `base-path/patch-upstream.mjs verify` starts the OpenCode of the image and stops the build when its page, bundle or stylesheet no longer carries what the front process adjusts.

## Image contract

- **F8** `tests/image-contract.sh` › no sh, no bash, no busybox, no perl in `mwaeckerlin/opencode:gateway`.

## Workflow contract

- **F9** `tests/workflow-contract.sh` of `mwaeckerlin/scratch` — the reusable workflow selects exactly the images a repository publishes; this repository calls it from `.github/workflows/docker.yml`.
