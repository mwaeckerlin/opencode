// Unit tests of plugin/subscription-login.js with a client that records what
// the plugin posts, fed with the events OpenCode 1.19.4 sends when LiteLLM
// answers 401 (the error object as measured in the image).
import assert from "node:assert/strict";
import test from "node:test";

import * as plugin from "./subscription-login.js";

const LOGIN = "https://litellm.example.com/mysubs";

const ERROR = {
  name: "APIError",
  data: {
    message: "litellm.AuthenticationError: mysubs: the ChatGPT login of openai-codex expired (invalid_grant); sign in again",
    statusCode: 401,
    isRetryable: false,
    responseBody: "{\"error\":{\"message\":\"litellm.AuthenticationError: mysubs: the ChatGPT login of openai-codex expired (invalid_grant); sign in again\",\"type\":\"auth_error\",\"param\":\"None\",\"code\":\"401\"}}",
  },
};

const answer = (sessionID, providerID, modelID) => ({
  type: "message.updated",
  properties: { sessionID, info: { id: `msg_${sessionID}`, role: "assistant", sessionID, providerID, modelID } },
});
const failure = (sessionID, error = ERROR) => ({ type: "session.error", properties: { sessionID, error } });

async function load(env, result = { data: { info: { role: "user" } } }) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name];
  const posted = [];
  const logged = [];
  const client = {
    session: { prompt: async (request) => (posted.push(request), result) },
    app: { log: async (request) => logged.push(request) },
  };
  try {
    const hooks = await plugin.SubscriptionLogin({ client });
    return { hooks, posted, logged };
  } finally {
    process.env = saved;
  }
}

test("the file exports the plugin alone, because OpenCode calls every export as a plugin", () => {
  assert.deepEqual(Object.keys(plugin), ["SubscriptionLogin"]);
});

test("a failed subscription model gets the login link in its session, without an answer of the model", async () => {
  const { hooks, posted } = await load({ LITELLM_SUBSCRIPTION_LOGIN_URL: LOGIN, LITELLM_SUBSCRIPTION_MODEL_PREFIX: undefined });
  await hooks.event({ event: answer("ses_a", "litellm", "mysubs/gpt-5") });
  await hooks.event({ event: failure("ses_a") });
  assert.deepEqual(posted, [{
    path: { id: "ses_a" },
    body: {
      noReply: true,
      parts: [{ type: "text", text: `The subscription model mysubs/gpt-5 failed: ${ERROR.data.message}\n\nSign in to the subscriptions again: ${LOGIN}` }],
    },
  }]);
});

test("another model, another provider, an aborted answer and an error without its model get no link", async () => {
  const { hooks, posted } = await load({ LITELLM_SUBSCRIPTION_LOGIN_URL: LOGIN });
  await hooks.event({ event: answer("ses_b", "litellm", "gpt-4o-mini") });
  await hooks.event({ event: failure("ses_b") });
  await hooks.event({ event: answer("ses_c", "openai", "mysubs/gpt-5") });
  await hooks.event({ event: failure("ses_c") });
  await hooks.event({ event: answer("ses_d", "litellm", "mysubs/gpt-5") });
  await hooks.event({ event: failure("ses_d", { name: "MessageAbortedError", data: { message: "Aborted" } }) });
  await hooks.event({ event: failure("ses_unknown") });
  await hooks.event({ event: { type: "session.error", properties: { error: ERROR } } });
  assert.deepEqual(posted, []);
});

test("the prefix of the subscription models is a setting", async () => {
  const { hooks, posted } = await load({ LITELLM_SUBSCRIPTION_LOGIN_URL: LOGIN, LITELLM_SUBSCRIPTION_MODEL_PREFIX: "chatgpt-" });
  await hooks.event({ event: answer("ses_e", "litellm", "mysubs/gpt-5") });
  await hooks.event({ event: failure("ses_e") });
  await hooks.event({ event: answer("ses_f", "litellm", "chatgpt-5") });
  await hooks.event({ event: failure("ses_f") });
  assert.deepEqual(posted.map((request) => request.path.id), ["ses_f"]);
});

test("the model of the last answer of a session decides", async () => {
  const { hooks, posted } = await load({ LITELLM_SUBSCRIPTION_LOGIN_URL: LOGIN });
  await hooks.event({ event: answer("ses_g", "litellm", "mysubs/gpt-5") });
  await hooks.event({ event: answer("ses_g", "litellm", "gpt-4o-mini") });
  await hooks.event({ event: failure("ses_g") });
  await hooks.event({ event: answer("ses_g", "litellm", "mysubs/gpt-5") });
  await hooks.event({ event: { type: "message.updated", properties: { info: { role: "user", sessionID: "ses_g", model: { providerID: "litellm", modelID: "gpt-4o-mini" } } } } });
  await hooks.event({ event: failure("ses_g") });
  assert.equal(posted.length, 1);
});

test("without a login address, or with one that is not http or https, the plugin does nothing", async () => {
  for (const value of [undefined, "", "javascript:alert(1)", "litellm/mysubs"]) {
    const { hooks } = await load({ LITELLM_SUBSCRIPTION_LOGIN_URL: value });
    assert.deepEqual(hooks, {}, String(value));
  }
});

test("a link OpenCode refuses to take is logged with the session", async () => {
  const { hooks, posted, logged } = await load({ LITELLM_SUBSCRIPTION_LOGIN_URL: LOGIN }, { error: { name: "NotFoundError" } });
  await hooks.event({ event: answer("ses_h", "litellm", "mysubs/gpt-5") });
  await hooks.event({ event: failure("ses_h") });
  assert.equal(posted.length, 1);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].body.level, "error");
  assert.deepEqual(logged[0].body.extra, { session: "ses_h", error: { name: "NotFoundError" } });
});
