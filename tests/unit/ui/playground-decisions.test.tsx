// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: (loader: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>) => {
      const Component = React.lazy(loader);
      return function Lazy(props: Record<string, unknown>) {
        return (
          <React.Suspense fallback={null}>
            <Component {...props} />
          </React.Suspense>
        );
      };
    },
  };
});
vi.mock("@/shared/components", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({
    children,
    icon: _icon,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: string; variant?: string }) => (
    <button {...props}>{children}</button>
  ),
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Select: ({
    options,
    placeholder: _placeholder,
    ...props
  }: React.SelectHTMLAttributes<HTMLSelectElement> & {
    options: Array<{ value: string; label: string }>;
    placeholder?: string;
  }) => (
    <select {...props}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/shared/components/MonacoEditor", () => ({
  default: ({ value, onChange }: { value: string; onChange?: (text: string) => void }) => (
    <textarea
      aria-label={onChange ? "Request JSON" : "Response JSON"}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      readOnly={!onChange}
    />
  ),
}));
vi.mock("@/shared/utils/dashboardCsrf", () => ({
  withDashboardCsrfHeader: async (headers: HeadersInit) => {
    const out = new Headers(headers);
    out.set("x-omniroute-csrf", "synthetic-csrf");
    return out;
  },
}));
vi.mock("@/store/emailPrivacyStore", () => ({ default: () => false }));
vi.mock("@/app/(dashboard)/dashboard/playground/components/StudioConfigPane", () => ({
  default: () => <aside aria-label="Chat settings" />,
}));
vi.mock("@/app/(dashboard)/dashboard/playground/components/ParamSliders", () => ({
  DEFAULT_PARAMS: {},
}));
vi.mock("@/app/(dashboard)/dashboard/playground/components/TokenCostCounter", () => ({
  default: () => <span>Chat token counter</span>,
}));
vi.mock("@/app/(dashboard)/dashboard/playground/components/ExportCodeModal", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/playground/components/tabs/ChatTab", () => ({
  default: () => <div>Chat content</div>,
}));
vi.mock("@/app/(dashboard)/dashboard/playground/components/tabs/CompareTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/playground/components/tabs/BuildTab", () => ({
  default: () => null,
}));

import { PlaygroundStudio } from "@/app/(dashboard)/dashboard/playground/PlaygroundStudio";
import ApiTab from "@/app/(dashboard)/dashboard/playground/components/tabs/ApiTab";

const models = [
  {
    id: "openai/gpt-6-luna",
    name: "Luna",
    provider: "openai",
    providerLabel: "OpenAI",
    connections: [{ id: "oa", name: "OpenAI account" }],
  },
  {
    id: "demo/vendor/decision",
    name: "Native test model",
    provider: "demo-node",
    providerLabel: "Native demo",
    connections: [{ id: "demo-account", name: "Demo account" }],
  },
];
const postCalls = () => vi.mocked(fetch).mock.calls.filter(([, opts]) => opts?.method === "POST");

beforeEach(() => {
  navigation.query = "";
  window.history.replaceState({}, "", "/dashboard/playground");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
      if (String(url).endsWith("/decisions/models")) return Response.json({ data: models });
      if (String(url) === "/v1/models")
        return Response.json({ data: [{ id: "codex/chat-model", owned_by: "codex" }] });
      if (String(url) === "/api/providers/client") return Response.json({ connections: [] });
      if (String(url) === "/api/playground/decisions" && opts?.method === "POST")
        return Response.json(
          {
            model: "vendor/decision",
            answers: [{ type: "predicate", probability: 1 }],
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
          { headers: { "x-omniroute-provider": "demo-node" } }
        );
      throw new Error("Unexpected test request");
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function chooseDemo() {
  await screen.findByRole("option", { name: "Native demo" });
  fireEvent.change(screen.getByRole("combobox", { name: "Provider", exact: true }), {
    target: { value: "demo-node" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Account", exact: true }), {
    target: { value: "demo-account" },
  });
}

describe("Shared Decisions API editor", () => {
  it("offers Decisions through the existing endpoint dropdown without selecting OpenAI implicitly", async () => {
    render(<ApiTab />);
    fireEvent.change(screen.getByRole("combobox", { name: "Endpoint", exact: true }), {
      target: { value: "decisions" },
    });
    await screen.findByRole("option", { name: "Native demo" });
    expect((screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement).value).toBe(
      ""
    );
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(postCalls()).toHaveLength(0);
    expect(screen.queryByText("OmniRoute client API key")).toBeNull();
  });

  it("preserves edited input/questions while selecting a different provider, model and account", async () => {
    render(<ApiTab initialEndpoint="decisions" />);
    await screen.findByRole("option", { name: "Native demo" });
    const editor = await screen.findByLabelText("Request JSON");
    const draft = {
      model: "",
      input: "Keep this input",
      questions: [{ type: "predicate", instructions: "Keep this question" }],
      prompt_cache_key: "test",
    };
    fireEvent.change(editor, { target: { value: JSON.stringify(draft) } });
    await chooseDemo();
    expect(JSON.parse((editor as HTMLTextAreaElement).value)).toEqual({
      ...draft,
      model: "demo/vendor/decision",
    });
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Decision status").textContent).toContain("HTTP 200")
    );
    const [url, opts] = postCalls()[0];
    expect(url).toBe("/api/playground/decisions");
    expect(JSON.parse(String(opts?.body))).toEqual({ ...draft, model: "demo/vendor/decision" });
    const headers = new Headers(opts?.headers);
    expect(headers.get("X-OmniRoute-Connection")).toBe("demo-account");
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("x-omniroute-csrf")).toBe(true);
    expect(opts?.credentials).toBe("same-origin");
    expect(postCalls()).toHaveLength(1);
  });

  it("rejects a raw JSON/model-selector mismatch without making a paid request", async () => {
    render(<ApiTab initialEndpoint="decisions" />);
    await chooseDemo();
    const editor = await screen.findByLabelText("Request JSON");
    const draft = JSON.parse((editor as HTMLTextAreaElement).value);
    fireEvent.change(editor, {
      target: { value: JSON.stringify({ ...draft, model: "codex/chat-model" }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Response JSON") as HTMLTextAreaElement).value).toContain(
        "must match"
      )
    );
    expect(postCalls()).toHaveLength(0);
  });

  it("keeps the Decisions shortcut and deep link in the same editor without chat settings", async () => {
    navigation.query = "tab=decisions";
    render(<PlaygroundStudio />);
    await screen.findByRole("option", { name: "Native demo" });
    expect((screen.getByRole("combobox", { name: "Endpoint" }) as HTMLSelectElement).value).toBe(
      "decisions"
    );
    expect(screen.queryByLabelText("Chat settings")).toBeNull();
    expect(screen.queryByRole("button", { name: "exportCode" })).toBeNull();
    expect(postCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole("tab", { name: "tabChat" }));
    expect(screen.getByLabelText("Chat settings")).toBeTruthy();
  });
});
