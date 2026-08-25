import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/providers/claude",
  useSearchParams: () => new URLSearchParams("view=key%2Fa"),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }) =>
    React.createElement("a", { href, ...props }, children),
}));

vi.mock("@/shared/components/ProviderIcon", () => ({
  default: () => null,
}));
vi.mock("@/shared/components/HeaderMenu", () => ({ default: () => null }));
vi.mock("@/shared/components/HeaderLanguage", () => ({ default: () => null }));
vi.mock("@/shared/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("@/shared/components/DonateModal", () => ({ default: () => null }));
vi.mock("@/store/headerSearchStore", () => ({
  useHeaderSearchStore: (selector) =>
    selector({
      visible: false,
      query: "",
      placeholder: "",
      setQuery: () => {},
    }),
}));
vi.mock("@/shared/constants/config", () => ({
  OAUTH_PROVIDERS: { claude: { id: "claude", name: "Claude" } },
  APIKEY_PROVIDERS: {},
}));
vi.mock("@/shared/constants/providers", () => ({
  MEDIA_PROVIDER_KINDS: [],
  AI_PROVIDERS: {},
}));
vi.mock("@/shared/utils/providerIcon", () => ({
  getProviderIconSrc: () => "/providers/claude.png",
}));
vi.mock("@/i18n/runtime", () => ({ translate: (value) => value }));

describe("Header provider breadcrumb", () => {
  it("returns to the Providers grid with the selected API-key view", async () => {
    const { default: Header } = await import("@/shared/components/Header");

    const html = renderToStaticMarkup(
      React.createElement(Header, { showMenuButton: false }),
    );

    expect(html).toContain(
      '<a href="/dashboard/providers?view=key%2Fa"',
    );
  });
});
