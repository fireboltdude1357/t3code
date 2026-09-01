import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("expo-file-system", () => ({ File: class {}, UploadType: { MULTIPART: "multipart" } }));
vi.mock("./preferences", () => ({ mobilePreferencesAtom: {} }));

import { normalizeLunaHostUrl } from "../features/voice-sidecar/lunaHostApi";
import { resolveLunaHost } from "./voice-sidecar-host";

describe("normalizeLunaHostUrl", () => {
  it("accepts https origins and strips trailing slashes", () => {
    expect(normalizeLunaHostUrl("https://stl-wsl.tail.ts.net:9456/")).toBe(
      "https://stl-wsl.tail.ts.net:9456",
    );
    expect(normalizeLunaHostUrl("http://192.168.1.20:8892")).toBe("http://192.168.1.20:8892");
  });

  it("assumes https when the scheme is missing", () => {
    expect(normalizeLunaHostUrl("stl-wsl.tail.ts.net:9456")).toBe(
      "https://stl-wsl.tail.ts.net:9456",
    );
  });

  it("rejects empty and unparseable values", () => {
    expect(normalizeLunaHostUrl("")).toBeNull();
    expect(normalizeLunaHostUrl("   ")).toBeNull();
    expect(normalizeLunaHostUrl("not a url at all")).toBeNull();
  });
});

describe("resolveLunaHost", () => {
  it("is not ready until preferences load", () => {
    expect(resolveLunaHost(null)).toEqual({ client: null, enabled: false, isReady: false });
  });

  it("requires both URL and token before creating a client", () => {
    expect(resolveLunaHost({ lunaHostUrl: "https://host:9456" }).client).toBeNull();
    expect(resolveLunaHost({ lunaHostToken: "token" }).client).toBeNull();
    const host = resolveLunaHost({ lunaHostUrl: "https://host:9456", lunaHostToken: "token" });
    expect(host.client?.baseUrl).toBe("https://host:9456");
    expect(host.enabled).toBe(true);
  });

  it("keeps the client but disables the button when Luna is switched off", () => {
    const host = resolveLunaHost({
      lunaHostUrl: "https://host:9456",
      lunaHostToken: "token",
      lunaEnabled: false,
    });
    expect(host.client).not.toBeNull();
    expect(host.enabled).toBe(false);
  });
});
