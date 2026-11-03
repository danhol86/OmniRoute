"use client";

import { useEffect, useRef, useState } from "react";

const example = {
  model: "openai/gpt-6-luna",
  input: "Build a React Native note-taking app with login.",
  questions: [
    { type: "predicate", name: "software", instructions: "Does this ask to build software?" },
    {
      type: "choice",
      name: "category",
      instructions: "Choose the task category.",
      choices: [
        { value: "coding", description: "Building or debugging software" },
        { value: "general", description: "Other everyday questions" },
      ],
    },
    {
      type: "score",
      name: "complexity",
      instructions: "Rate the task complexity.",
      levels: [
        { label: "simple", description: "A single basic operation" },
        { label: "multi_step", description: "Several connected implementation steps" },
      ],
    },
  ],
};

export default function DecisionsClient({ embedded = false }: { embedded?: boolean }) {
  const [key, setKey] = useState("");
  const [body, setBody] = useState(JSON.stringify(example, null, 2));
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function run() {
    setResult("");
    try {
      JSON.parse(body);
    } catch {
      setResult("Request must be valid JSON.");
      return;
    }
    setBusy(true);
    controller.current = new AbortController();
    const start = performance.now();
    try {
      const response = await fetch("/v1/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.trim()}` },
        body,
        signal: controller.current.signal,
        cache: "no-store",
      });
      const text = await response.text();
      let formatted = text;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* Keep non-JSON diagnostics readable. */
      }
      setResult(
        `HTTP ${response.status} | ${Math.round(performance.now() - start)} ms\n${formatted}`
      );
    } catch (error) {
      setResult(
        error instanceof Error && error.name === "AbortError"
          ? "Cancelled. OpenAI may already have processed the request."
          : "Request failed. Check your connection and try again."
      );
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-5">
      {!embedded && (
        <a href="/dashboard/endpoint" className="text-action hover:underline">
          Back to endpoints
        </a>
      )}
      <h1 className="text-2xl font-bold">OpenAI Decisions</h1>
      <p className="text-text-muted">
        Ask predicate, choice and score questions using your existing OpenAI provider connection.
        This does not change chat or combo routing.
      </p>
      <code className="rounded bg-card-subtle p-3">POST /v1/decisions</code>
      <label className="flex flex-col gap-2 font-medium">
        OmniRoute client API key
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste an OmniRoute key, not your OpenAI key"
          className="w-full rounded border border-border bg-card p-3 font-mono text-sm"
        />
      </label>
      <p className="text-sm text-text-muted">
        Use a key from the API Keys page with access to Decisions and openai/gpt-6-luna. The key
        stays in memory; it is not saved in browser storage.
      </p>
      <label className="flex flex-col gap-2 font-medium">
        Request JSON
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          spellCheck={false}
          rows={23}
          className="w-full rounded border border-border bg-card p-3 font-mono text-sm"
        />
      </label>
      <p className="text-sm text-text-muted">
        Run sends one real, billable request to OpenAI. Nothing is sent automatically. Gateway
        limit: 8 MiB; upstream timeout: 30 seconds.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          onClick={run}
          disabled={busy || !key.trim()}
          className="rounded bg-primary px-5 py-3 font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Running..." : "Run decision"}
        </button>
        {busy && (
          <button
            onClick={() => controller.current?.abort()}
            className="rounded border border-border px-5 py-3"
          >
            Cancel
          </button>
        )}
        <button
          onClick={() => setBody(JSON.stringify(example, null, 2))}
          disabled={busy}
          className="rounded border border-border px-5 py-3"
        >
          Reset example
        </button>
      </div>
      <pre
        aria-live="polite"
        aria-label="Decision result"
        className="min-h-24 whitespace-pre-wrap break-words rounded border border-border bg-card-subtle p-4 text-sm"
      >
        {result || "The response will appear here."}
      </pre>
    </section>
  );
}
