// OpenCode plugin of the sandbox: when a model of the LiteLLM subscriptions
// fails, the session gets the link to the login page as a message, without an
// answer of the model.
//
// OpenCode 1.19.4 announces a failed answer as `session.error` with the
// session and the error, `{ name: "APIError", data: { message, statusCode,
// isRetryable, responseBody } }`, after it retried a retryable error five
// times; the model stands in the `message.updated` of the answer, which
// arrives before. A model counts as a subscription model when its provider is
// LiteLLM and its name starts with LITELLM_SUBSCRIPTION_MODEL_PREFIX.
//
//   LITELLM_SUBSCRIPTION_LOGIN_URL      login page; without it the plugin does nothing
//   LITELLM_SUBSCRIPTION_MODEL_PREFIX   start of the model names, default mysubs/
//
// OpenCode calls every export of a plugin file as a plugin, so the file
// exports the plugin alone.

const PROVIDER = "litellm";

function loginUrl(value) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

// The text of the message, or nothing when the failure is no failure of a
// subscription model.
function notice(error, model, url, prefix) {
  if (!model || model.providerID !== PROVIDER || !String(model.modelID ?? "").startsWith(prefix)) return "";
  if (!error || error.name === "MessageAbortedError") return "";
  const cause = typeof error.data?.message === "string" && error.data.message ? `: ${error.data.message}` : "";
  return `The subscription model ${model.modelID} failed${cause}\n\nSign in to the subscriptions again: ${url}`;
}

export const SubscriptionLogin = async ({ client }) => {
  const url = loginUrl(process.env.LITELLM_SUBSCRIPTION_LOGIN_URL);
  const prefix = process.env.LITELLM_SUBSCRIPTION_MODEL_PREFIX || "mysubs/";
  if (!url) return {};
  // the model of the last answer per session
  const models = new Map();
  return {
    event: async ({ event }) => {
      const properties = event.properties ?? {};
      if (event.type === "message.updated" && properties.info?.role === "assistant") {
        models.set(properties.info.sessionID, { providerID: properties.info.providerID, modelID: properties.info.modelID });
        return;
      }
      if (event.type === "session.deleted") {
        models.delete(properties.info?.id);
        return;
      }
      if (event.type !== "session.error" || !properties.sessionID) return;
      const text = notice(properties.error, models.get(properties.sessionID), url, prefix);
      if (!text) return;
      const answer = await client.session.prompt({
        path: { id: properties.sessionID },
        body: { noReply: true, parts: [{ type: "text", text }] },
      });
      if (answer?.error) {
        await client.app.log({
          body: { service: "subscription-login", level: "error", message: "the login link could not be posted", extra: { session: properties.sessionID, error: answer.error } },
        });
      }
    },
  };
};
