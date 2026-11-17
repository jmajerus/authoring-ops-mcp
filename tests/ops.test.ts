import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ago, dashboardPage } from "../src/dashboard.js";
import { Poller } from "../src/poller.js";
import { readHealth } from "../src/probes.js";
import { serveHttp } from "../src/server.js";
import { Store } from "../src/store.js";

const config = parseConfig({
  suite: "test",
  tool_budget: 10,
  services: [
    { name: "a-mcp", health: "http://a/health", mcp: "http://a/mcp", repo: "me/a-mcp" },
    { name: "b-mcp", mcp: "http://b/mcp", third_party: true },
  ],
  subscribers: { url: "http://t/api/subscribers", owner: "me/t-mcp" },
  checks: { url: "http://h/api/checks", owner: "me/h-mcp" },
});

/** A suite in which everything is as it should be; each test breaks one thing. */
function world() {
  const w = {
    now: new Date("2026-11-16T12:00:00Z"),
    listed: 0,
    health: { ok: true, version: "1.0.0", deployed: { branch: "main", commit: "abcdef0123456789", at: "2026-11-15T12:00:00Z" } } as unknown,
    tools: { "http://a/mcp": ["one", "two"], "http://b/mcp": ["three"] } as Record<string, string[] | Error>,
    subscribers: { version: 7, subscribers: [{ id: "a-mcp", label: "A", schemes: ["s"], pending: 0, pendingBreaking: 0, blocked: null, lastSeen: "2026-11-16T11:59:00Z" }] } as unknown,
    checks: { checks: [{ name: "fine", result: "ok", count: 0, fix: "a-mcp", examples: [] }] } as unknown,
    tick(minutes: number) { w.now = new Date(w.now.getTime() + minutes * 60_000); },
  };
  const poller = new Poller(config, new Store(), {
    clock: () => w.now,
    fetchJson: async (url) => {
      const body = url.endsWith("/health") ? w.health : url.includes("subscribers") ? w.subscribers : w.checks;
      if (body instanceof Error) throw body;
      return body;
    },
    listTools: async (url) => {
      w.listed++;
      const t = w.tools[url];
      if (t instanceof Error) throw t;
      return t;
    },
  });
  return { w, poller };
}
const ids = (s: { findings: { id: string }[] }) => s.findings.map((f) => f.id);

describe("config", () => {
  it("rejects a service with nothing to probe, and a duplicate", () => {
    expect(() => parseConfig({ suite: "x", services: [{ name: "a" }] })).toThrow(/nothing to probe/);
    expect(() => parseConfig({ suite: "x", services: [{ name: "a", mcp: "http://a" }, { name: "a", mcp: "http://a" }] })).toThrow(/twice/);
    expect(() => parseConfig({ suite: "x", services: [{ name: "a", mcp: "ftp://a" }] })).toThrow(/http/);
  });
  it("reads the suite this repository ships", () => {
    const shipped = parseConfig(JSON.parse(fs.readFileSync("suites/authoring.json", "utf8")));
    expect(shipped.services.map((s) => s.name)).toContain("zotero-mcp");
    expect(shipped.subscribers?.lag_minutes).toBe(30);
  });
});

describe("health contract", () => {
  it("keeps what a server sends and guesses nothing else", () => {
    expect(readHealth({ ok: true, version: 345 }, "t")).toEqual({ ok: true, version: "345", checked_at: "t" });
    expect(readHealth({ ok: false }, "t")).toMatchObject({ ok: false, error: "reports ok: false" });
    expect(readHealth("up", "t").ok).toBe(false);
    expect(readHealth({ checks: { ok: 3 }, dependencies: [{ name: "zotero", ok: false }], admin: "javascript:alert(1)" }, "t")).toEqual({ ok: true, dependencies: [{ name: "zotero", ok: false }], checked_at: "t" });
  });
});

describe("polling", () => {
  it("finds nothing in a healthy suite", async () => {
    const { poller } = world();
    const s = await poller.poll();
    expect(s.findings).toEqual([]);
    expect(s.services.map((v) => v.up)).toEqual([true, true]);
    expect(s.tools_total).toBe(5);
  });

  it("reports a service down since it went down, and forgets it once it's back", async () => {
    const { w, poller } = world();
    await poller.poll();
    w.tick(1);
    const good = w.health;
    w.health = new Error("ECONNREFUSED");
    const wentDown = w.now.toISOString();
    await poller.poll();
    w.tick(5);
    const s = await poller.poll();
    expect(s.findings).toMatchObject([{ id: "down:a-mcp", severity: "fail", fix: "me/a-mcp", first_seen: wentDown }]);
    expect(s.services[0]).toMatchObject({ up: false, since: wentDown });
    w.health = good;
    expect((await poller.poll()).findings).toEqual([]);
  });

  it("takes a tool listing as the sign of life for a service with no /health, every poll", async () => {
    const { w, poller } = world();
    await poller.poll();
    expect(w.listed).toBe(2);
    w.tick(1);
    w.tools["http://b/mcp"] = new Error("ECONNREFUSED");
    const s = await poller.poll();
    expect(w.listed).toBe(3); // a-mcp's listing is still fresh
    expect(ids(s)).toEqual(["down:b-mcp"]);
    expect(s.services[1].tools?.names).toEqual(["three"]); // the last good listing is kept
  });

  it("tells a service that's up but won't list its tools from one that's down", async () => {
    const { w, poller } = world();
    w.tools["http://a/mcp"] = new Error("HTTP 500");
    const s = await poller.poll();
    expect(s.services[0].up).toBe(true);
    expect(ids(s)).toEqual(["mcp:a-mcp"]);
  });

  it("reports a branch or an unclean checkout, from when it was deployed", async () => {
    const { w, poller } = world();
    w.health = { ok: true, deployed: { branch: "feat/x", commit: "abc", at: "2026-11-10T00:00:00Z", dirty: true } };
    const s = await poller.poll();
    expect(ids(s).sort()).toEqual(["branch:a-mcp", "dirty:a-mcp"]);
    expect(s.findings[0].first_seen).toBe("2026-11-10T00:00:00Z");
  });

  it("waits out a subscriber's lag before reporting it, and reports a block at once", async () => {
    const { w, poller } = world();
    const sub = (w.subscribers as { subscribers: Record<string, unknown>[] }).subscribers[0];
    sub.pending = 3;
    expect((await poller.poll()).findings).toEqual([]);
    w.tick(31);
    sub.lastSeen = w.now.toISOString();
    expect(await poller.poll()).toMatchObject({ findings: [{ id: "subscriber-pending:a-mcp", severity: "drift", fix: "me/a-mcp" }] });
    sub.blocked = "term 9 was retired";
    expect(ids(await poller.poll())).toEqual(["subscriber-blocked:a-mcp"]);
  });

  it("reports a subscriber that has gone quiet", async () => {
    const { w, poller } = world();
    w.tick(120);
    expect(ids(await poller.poll())).toEqual(["subscriber-quiet:a-mcp"]);
  });

  it("passes on the cross-service checks with their owner and age, fails first", async () => {
    const { w, poller } = world();
    w.checks = { checks: [
      { name: "waiting", result: "drift", count: 2, fix: "a person", first_seen: "2026-11-01T00:00:00Z", examples: [{ ref: "x", detail: "x is waiting" }] },
      { name: "broken", result: "fail", count: 1, fix: "b-mcp", first_seen: "2026-11-14T00:00:00Z", examples: [] },
      { name: "unknown", result: "skipped", count: 0, fix: "b-mcp", examples: [] },
    ] };
    const s = await poller.poll();
    expect(s.findings).toMatchObject([
      { id: "cross-service:broken", severity: "fail", fix: "b-mcp", first_seen: "2026-11-14T00:00:00Z" },
      { id: "cross-service:waiting", severity: "drift", fix: "a person", examples: ["x is waiting"] },
    ]);
  });

  it("gives a source five minutes before calling it unreadable, and reports a blown tool budget", async () => {
    const { w, poller } = world();
    w.checks = new Error("HTTP 502");
    w.tools["http://b/mcp"] = Array.from({ length: 9 }, (_, i) => `t${i}`);
    expect(ids(await poller.poll())).toEqual(["tool-budget"]);
    w.tick(6);
    expect(ids(await poller.poll()).sort()).toEqual(["source:checks", "tool-budget"]);
  });

  it("keeps since-times across a restart", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ops-")), "state.json");
    const first = new Store(file);
    expect(first.since("a", false, "2026-11-01T00:00:00Z")).toBe("2026-11-01T00:00:00Z");
    first.save();
    expect(new Store(file).since("a", false, "2026-11-02T00:00:00Z")).toBe("2026-11-01T00:00:00Z");
    expect(new Store(file).since("a", true, "2026-11-02T00:00:00Z")).toBe("2026-11-02T00:00:00Z");
  });
});

describe("the server", () => {
  it("serves the dashboard, /health, and both tools", async () => {
    const { w, poller } = world();
    w.health = { ok: true, version: "<b>1</b>", deployed: { branch: "main", commit: "abcdef0123", at: "2026-11-15T12:00:00Z", dirty: true } };
    const server = await serveHttp(poller, { host: "127.0.0.1", port: 0, stateDir: "/nonexistent" });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/`)).text()).toContain("first poll");
      await poller.poll();
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain("a-mcp");
      expect(page).toContain("uncommitted changes");
      expect(page).not.toContain("<b>1</b>");
      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, service: "test-ops-mcp", deployed: null, findings: { fail: 0, drift: 1 } });
      expect((await fetch(`${base}/api/poll`)).status).toBe(405);
      expect((await fetch(`${base}/`, { headers: { "cf-ray": "x" } })).status).toBe(401);

      const client = new Client({ name: "test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["findings", "status"]);
      const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
      expect(text(await client.callTool({ name: "status", arguments: {} }))).toMatchObject({
        suite: "test", services: [{ name: "a-mcp", up: true, tools: 2, deployed: { commit: "abcdef0", dirty: true } }, { name: "b-mcp", third_party: true }],
        findings: { fail: 0, drift: 1 },
      });
      expect(text(await client.callTool({ name: "findings", arguments: {} })).findings).toMatchObject([{ id: "dirty:a-mcp", fix: "me/a-mcp" }]);
      await client.close();
    } finally {
      server.close();
    }
  });

  it("says how long ago in the nearest unit worth reading", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    expect([ago("2026-11-16T11:59:50Z", now), ago("2026-11-16T11:15:00Z", now), ago("2026-11-16T07:00:00Z", now), ago("2026-11-09T12:00:00Z", now), ago(null, now)])
      .toEqual(["just now", "45 min", "5 h", "7 d", ""]);
    expect(dashboardPage(undefined, "x")).toContain("first poll");
  });
});
