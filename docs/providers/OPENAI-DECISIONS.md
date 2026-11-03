---
title: "OpenAI Decisions"
version: "3.8.52"
lastUpdated: "2026-11-03"
---

# OpenAI Decisions

This independent, OpenAI-only extension exposes `POST /v1/decisions`. It does not
include upstream PR #18838 or #18283, introduce a System One adapter, or modify combos.
It uses an existing active **OpenAI API-key** connection in Providers. Codex OAuth
is not an OpenAI API key and cannot serve this endpoint.

Open **Playground -> Decisions**, or `/dashboard/playground?tab=decisions`.
The original **Endpoints -> OpenAI Decisions** page at `/dashboard/endpoint/decisions`
also remains available. Both entry points use the same request editor and API.
Paste an **OmniRoute client key**, leave the example in place and select **Run decision**.
The example exercises all three question types in one real, billable call. The page
does not save keys or requests to browser storage or run inference automatically.
Chat-only configuration and export controls are hidden on the Decisions tab. Leaving
the tab cancels the browser request; an upstream request may already have been processed.

```bash
curl "$OMNIROUTE_URL/v1/decisions" \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-6-luna","input":"Please refund a duplicate charge.","questions":[{"type":"predicate","name":"refund","instructions":"Is a refund requested?"}]}'
```

Both `gpt-6-luna` and `openai/gpt-6-luna` select the direct OpenAI connection.
The provider prefix is removed before sending the request to OpenAI. Other native
request fields and successful answer/usage payloads pass through without translation;
OpenAI validates nested input, question and caching options. Refusals remain refusals.
See the [official API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).

Client-key model, endpoint, budget, token and connection restrictions still apply.
Keys limited to chat do not gain Decisions access. Invalid or missing client keys get 401. No eligible OpenAI connection gets 503. Gateway requests are limited to 8 MiB,
responses to 2 MiB, and upstream work to 30 seconds. Redirects and automatic retries
are disabled. Upstream failures retain their HTTP status and Retry-After header but
not their raw response body. Inputs and answers are not written to call logs by this
extension; OpenAI's own retention policies still apply.

Usage is attributed to the selected connection and client key. The budget estimate
uses standard direct OpenAI Decisions input/cache rates, never an output-token charge;
it is not a provider invoice or a hard concurrent-spend reservation. No provider
credentials, schema migrations or extra environment variables are introduced.
