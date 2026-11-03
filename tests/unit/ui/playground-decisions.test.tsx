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
      return function LazyTab(props: Record<string, unknown>) {
        return (
          <React.Suspense fallback={null}>
            <Component {...props} />
          </React.Suspense>
        );
      };
    },
  };
});
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
vi.mock("@/app/(dashboard)/dashboard/playground/components/tabs/ApiTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/playground/components/tabs/BuildTab", () => ({
  default: () => null,
}));

import { PlaygroundStudio } from "@/app/(dashboard)/dashboard/playground/PlaygroundStudio";

describe("Playground Decisions integration", () => {
  beforeEach(() => {
    navigation.query = "";
    window.history.replaceState({}, "", "/dashboard/playground");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({ model: "gpt-6-luna", answers: [] }),
      })
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("exposes Decisions as a tab without changing the default Chat tab", async () => {
    render(<PlaygroundStudio />);
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(screen.getByRole("tab", { name: "tabChat" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Decisions", exact: true }));
    await screen.findByRole("heading", { name: "OpenAI Decisions" });
    expect(screen.getByRole("tab", { name: "Decisions" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    expect(screen.queryByLabelText("Chat settings")).toBeNull();
    expect(screen.queryByRole("button", { name: "exportCode" })).toBeNull();
    expect(screen.queryByText("Chat token counter")).toBeNull();
    expect(screen.queryByText("Back to endpoints")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.get("tab")).toBe("decisions");
    fireEvent.click(screen.getByRole("tab", { name: "tabChat" }));
    expect(screen.getByLabelText("Chat settings")).toBeTruthy();
  });

  it("opens the Decisions editor from the shareable deep link", async () => {
    navigation.query = "tab=decisions";
    render(<PlaygroundStudio />);
    await screen.findByRole("heading", { name: "OpenAI Decisions" });
    expect(screen.getByRole("tab", { name: "Decisions" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs only after a client key and explicit click, through the Decisions endpoint", async () => {
    navigation.query = "tab=decisions";
    render(<PlaygroundStudio />);
    const run = await screen.findByRole("button", { name: "Run decision" });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("OmniRoute client API key"), {
      target: { value: "test-client-key" },
    });
    fireEvent.click(run);
    await waitFor(() =>
      expect(screen.getByLabelText("Decision result").textContent).toContain("HTTP 200")
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/v1/decisions");
    expect(JSON.parse(options!.body as string).questions).toHaveLength(3);
    expect(options!.headers).toMatchObject({ Authorization: "Bearer test-client-key" });
    expect(Object.values(localStorage).some((value) => value.includes("test-client-key"))).toBe(
      false
    );
  });

  it("cancels an in-flight request when leaving Decisions", async () => {
    navigation.query = "tab=decisions";
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError"))
          );
        })
    );
    render(<PlaygroundStudio />);
    await screen.findByRole("heading", { name: "OpenAI Decisions" });
    fireEvent.change(screen.getByLabelText("OmniRoute client API key"), {
      target: { value: "test-client-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run decision" }));
    await waitFor(() => expect(signal).toBeDefined());
    fireEvent.click(screen.getByRole("tab", { name: "tabChat" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });
});
