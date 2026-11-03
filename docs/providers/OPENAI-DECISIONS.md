---
title: "Native Decisions"
version: "3.8.52"
lastUpdated: "2026-11-03"
---

# Native Decisions

Use **Playground -> API -> Endpoint: Decisions**. The **Decisions** tab and the
original `/dashboard/endpoint/decisions` URL open the same API editor with that
endpoint preselected. Chat's configuration endpoint list also links to Decisions.

Select **Provider**, **Model**, then **Account** (or Auto for the selected provider).
The list is loaded from saved configuration, not the unrelated chat model catalog.
No provider is preselected for Decisions. Choosing a model updates only the model
field in your JSON, preserving edited input, questions and native request options.
The account selection is enforced server-side and never falls back to another
provider. Unsupported models and invalid account selections are rejected.

The signed-in session authorizes browser calls through `/api/playground/decisions`.
No client key is entered, generated or sent by the browser. Session expiry,
revocation, session-bound CSRF and cross-site protections remain enforced.
External callers still use `POST /v1/decisions` with an OmniRoute client key:

```bash
curl "$OMNIROUTE_URL/v1/decisions" \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-6-luna","input":"Please refund a duplicate charge.","questions":[{"type":"predicate","name":"refund","instructions":"Is a refund requested?"}]}'
```

`gpt-6-luna` remains an alias for `openai/gpt-6-luna`. The direct OpenAI route uses
an existing active OpenAI API-key connection. Codex OAuth and chat models are not
native Decisions providers. The upstream request uses the selected model rather
than unconditionally rewriting it to Luna.

## Additional native-compatible providers

A saved OpenAI-compatible provider node may participate when its custom model is
explicitly marked with the `decisions` supported-endpoint tag in the model's
endpoint-capability editor. The upstream must actually implement the native
OpenAI Decisions request/answer schema. A chat-compatible label alone is not proof
of that support. Models without an explicit trusted Decisions tag are not listed.
Use the node's configured prefix in the public model ID, for example
`my-native-provider/vendor/model`. It is resolved through saved node configuration,
never a client-supplied upstream URL. Only HTTPS upstream bases are admitted;
public-only outbound URL/DNS checks block private and metadata destinations.
No redirects, retries or chat/System One emulation are performed.

Optional `X-OmniRoute-Connection: <saved-account-id>` pins a compatible active
account. It is intersected with client-key connection/quota permissions, not used
to override them. Responses include `X-OmniRoute-Provider`, `X-OmniRoute-Model` and
`X-OmniRoute-Connection-Id` to identify the resolved route without exposing keys.

## Limits and accounting

Existing client-key endpoint/model/budget/quota restrictions remain enforced.
Missing or invalid external keys get 401; session cookies do not replace them.
Requests are bounded to 8 MiB, responses to 2 MiB and upstream work to 30 seconds.
The form sends nothing automatically. Request/response JSON is not persisted by
this extension. Provider-side retention policies still apply.

The direct OpenAI route retains its input/cache-rate estimate and no output charge.
Other native-compatible routes use their configured model pricing; unknown costs
are labelled unpriced, never given OpenAI's rate. Client-key requests to such a
route require configured pricing before dispatch. Session-mode usage is attributed
to the selected provider account, not an unrelated client key.

Neither rejected upstream PR is included. This feature does not alter chat or
combo routing, and does not make arbitrary models compatible with Decisions.
