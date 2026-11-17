import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ago, dashboardPage } from "../src/dashboard.js";
import { instructions } from "../src/mcp.js";
import { Poller } from "../src/poller.js";
import { readHealth } from "../src/probes.js";
import { serveHttp } from "../src/server.js";
import { type SkillSet, loadSkills, readSkillFile } from "../src/skills.js";
import { Store } from "../src/store.js";

const config = parseConfig({
  suite: "test",
  portal: "https://portal.example/mcp",
  tool_budget: 10,
  services: [
    { name: "a-mcp", health: "http://a/health", mcp: "http://a/mcp", repo: "me/a-mcp", public: "https://a.example/" },
    { name: "b-mcp", mcp: "http://b/mcp", third_party: true },
  ],
  subscribers: { url: "http://t/api/subscribers", owner: "me/t-mcp" },
  checks: { url: "http://h/api/checks", owner: "me/h-mcp", worklist: "http://h/worklist" },
  guidance: ["Start a lookup at a-mcp."],
});

/** A vendored skills folder: one skill calling a-mcp's `one` and naming `two_more`, with a shared file. */
function skillsDir(toolsUsed: unknown = { "a-mcp": ["one"] }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-skills-"));
  fs.mkdirSync(path.join(dir, "survey"));
  fs.writeFileSync(path.join(dir, "survey/SKILL.md"), "---\nname: survey\ndescription: Survey a topic. Use when asked what the library has.\n---\n\n# Survey\n\nRead [library.md](library.md). Call `one`, then `two_more` and `check`; report `page_label`.\n");
  fs.writeFileSync(path.join(dir, "survey/library.md"), "# The library\n");
  fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ repo: "me/skills", ref: "v1.0.0", commit: "0123456789abcdef" }));
  if (toolsUsed) fs.writeFileSync(path.join(dir, "tools-used.json"), JSON.stringify(toolsUsed));
  return dir;
}


/** A suite in which everything is as it should be; each test breaks one thing. */
function world(skills?: SkillSet) {
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
    clock: () => w.now, skills,
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
/** No Access team, whatever the shell's ACCESS_TEAM_DOMAIN says (the deploy runs the tests with .env loaded). */
const NO_TEAM = { lanHosts: [] };

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
    expect(s.tools_total).toBe(5); // with no skills, only status and findings are this server's
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
      { id: "cross-service:waiting", severity: "drift", fix: "a person", summary: "waiting: 2 found.", link: "http://h/worklist" },
    ]);
    expect(JSON.stringify(s.findings)).not.toContain("x is waiting"); // the examples stay on the worklist
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

describe("skills", () => {
  it("loads what a release carries, and nothing when it carries none", () => {
    expect(loadSkills(path.join(os.tmpdir(), "no-such-skills"))).toBeUndefined();
    const set = loadSkills(skillsDir())!;
    expect(set.skills).toEqual([{ name: "survey", description: "Survey a topic. Use when asked what the library has.", files: ["SKILL.md", "library.md"] }]);
    expect(set.mentioned).toEqual(["check", "one", "page_label", "two_more"]);
    expect(readSkillFile(set, "survey", "library.md")).toBe("# The library\n");
    expect(() => readSkillFile(set, "survey", "../version.json")).toThrow(/no file/);
    expect(() => readSkillFile(set, "nope")).toThrow(/The skills are: survey/);
  });

  it("finds nothing while the services list what the skills call", async () => {
    const { poller } = world(loadSkills(skillsDir()));
    const s = await poller.poll();
    expect(s.findings).toEqual([]);
    expect(s.skills).toMatchObject({ version: { ref: "v1.0.0" }, names: ["survey"], tools_checked: 1 });
    expect(s.tools_total).toBe(7);
  });

  it("reports a tool the skills call that a service dropped, but not from a listing that failed", async () => {
    const { w, poller } = world(loadSkills(skillsDir()));
    w.tools["http://a/mcp"] = ["two"];
    expect((await poller.poll()).findings).toMatchObject([{ id: "skills:missing:a-mcp:one", severity: "fail", fix: "me/a-mcp; or me/skills, if the rename was meant" }]);
    w.tick(11);
    w.tools["http://a/mcp"] = new Error("HTTP 500");
    expect(ids(await poller.poll())).toEqual(["mcp:a-mcp"]);
  });

  it("reports a tool a skill names that the list doesn't watch, a service the suite lacks, and a missing list", async () => {
    const a = world(loadSkills(skillsDir({ "a-mcp": ["one"], "z-mcp": ["gone"] })));
    a.w.tools["http://b/mcp"] = ["check", "three", "two_more"];
    expect(ids(await a.poller.poll()).sort()).toEqual(["skills:service:z-mcp", "skills:unwatched:b-mcp:check", "skills:unwatched:b-mcp:two_more"]);
    const b = world(loadSkills(skillsDir(null)));
    expect(ids(await b.poller.poll())).toEqual(["skills:no-tool-list"]);
  });

  it("puts the suite's guidance in the instructions, and mentions skills only when there are some", () => {
    const withSkills = instructions(world(loadSkills(skillsDir())).poller);
    expect(withSkills).toContain("Start a lookup at a-mcp.");
    expect(withSkills).toContain("get_skill");
    expect(instructions(world().poller)).not.toContain("get_skill");
    expect(withSkills.length).toBeLessThan(1200);
  });
});

describe("vendoring the skills", () => {
  // The script is plain JavaScript beside the build; vitest imports it as it is.
  const repo = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-vendor-"));
    const checkout = path.join(root, "skills-repo");
    fs.mkdirSync(path.join(checkout, "survey"), { recursive: true });
    fs.mkdirSync(path.join(checkout, "shared"));
    fs.writeFileSync(path.join(checkout, "survey/SKILL.md"), "---\nname: survey\ndescription: d\n---\n");
    fs.writeFileSync(path.join(checkout, "shared/library.md"), "# shared\n");
    fs.symlinkSync("../shared/library.md", path.join(checkout, "survey/library.md"));
    fs.writeFileSync(path.join(checkout, "tools-used.json"), "{}");
    fs.writeFileSync(path.join(root, "secret.txt"), "not a skill\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "skills"); git("tag", "v1");
    const suite = path.join(root, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ skills: { repo: "me/skills-repo", ref: "v1" } }));
    return { root, checkout, suite, git, out: path.join(root, "out") };
  };

  it("copies a link to a shared file as the file, and says whether tools-used.json came along", async () => {
    const { vendorSkills } = await import("../tools/vendor-skills.mjs");
    const r = repo();
    expect(vendorSkills({ from: r.checkout, out: r.out, suite: r.suite })).toMatchObject({ ref: "v1", skills: ["survey"], tools_used: true });
    expect(fs.lstatSync(path.join(r.out, "survey/library.md")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(r.out, "survey/library.md"), "utf8")).toBe("# shared\n");
  });

  it("refuses a link out of the skills, or to a folder, and leaves no copy", async () => {
    const { vendorSkills } = await import("../tools/vendor-skills.mjs");
    const r = repo();
    fs.symlinkSync("../../secret.txt", path.join(r.checkout, "survey/secret.md"));
    expect(() => vendorSkills({ worktree: true, from: r.checkout, out: r.out, suite: r.suite })).toThrow(/links outside the skills/);
    expect(fs.existsSync(r.out)).toBe(false);
    fs.rmSync(path.join(r.checkout, "survey/secret.md"));
    fs.symlinkSync("../shared", path.join(r.checkout, "survey/shared"));
    expect(() => vendorSkills({ worktree: true, from: r.checkout, out: r.out, suite: r.suite })).toThrow(/links to a folder/);
  });
});

describe("the server", () => {
  it("serves the dashboard, /health, and both tools", async () => {
    const { w, poller } = world(loadSkills(skillsDir()));
    w.health = { ok: true, version: "<b>1</b>", deployed: { branch: "main", commit: "abcdef0123", at: "2026-11-15T12:00:00Z", dirty: true } };
    const server = await serveHttp(poller, { host: "127.0.0.1", port: 0, stateDir: "/nonexistent", access: NO_TEAM });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/`)).text()).toContain("first poll");
      await poller.poll();
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain("a-mcp");
      expect(page).toContain("uncommitted changes");
      expect(page).toContain("me/skills at v1.0.0 (0123456)");
      expect(page).not.toContain("<b>1</b>");
      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, service: "test-ops-mcp", deployed: null, skills: { ref: "v1.0.0", count: 1 }, findings: { fail: 0, drift: 1 } });
      expect((await fetch(`${base}/api/poll`)).status).toBe(405);
      for (const p of ["/admin", "/health", "/api/status"]) expect((await fetch(`${base}${p}`, { headers: { "cf-ray": "x" } })).status).toBe(401);
      expect((await fetch(`${base}/mcp`, { method: "POST", headers: { "cf-ray": "x" } })).status).toBe(401);

      const client = new Client({ name: "test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["findings", "get_skill", "list_skills", "status"]);
      const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
      expect(text(await client.callTool({ name: "status", arguments: {} }))).toMatchObject({
        suite: "test", services: [{ name: "a-mcp", up: true, tools: 2, deployed: { commit: "abcdef0", dirty: true } }, { name: "b-mcp", third_party: true }],
        findings: { fail: 0, drift: 1 },
      });
      expect(text(await client.callTool({ name: "findings", arguments: {} })).findings).toMatchObject([{ id: "dirty:a-mcp", fix: "me/a-mcp" }]);
      expect(text(await client.callTool({ name: "list_skills", arguments: {} }))).toMatchObject({ source: "me/skills at v1.0.0 (0123456)", skills: [{ name: "survey" }] });
      const skill = await client.callTool({ name: "get_skill", arguments: { name: "survey" } }) as { content: { text: string }[] };
      expect(skill.content[0].text).toMatch(/^\[survey\/SKILL\.md, from me\/skills at v1\.0\.0[^\n]*library\.md[^\n]*\]\n\n---\nname: survey/);
      expect(await client.callTool({ name: "get_skill", arguments: { name: "survey", file: "../../etc/passwd" } })).toMatchObject({ isError: true });
      await client.close();
    } finally {
      server.close();
    }
  });

  it("keeps addresses, errors, and writable links off the public page, and puts them on /admin", async () => {
    const { w, poller } = world();
    w.tools["http://b/mcp"] = new Error("connect ECONNREFUSED 192.168.7.7:8000");
    w.subscribers = { version: 7, subscribers: [{ id: "a-mcp", label: "A", schemes: ["s"], pending: 0, blocked: "scheme s gone at 10.0.0.9", lastSeen: "2026-11-16T11:59:00Z" }] };
    w.checks = { checks: [{ name: "joins", result: "fail", count: 2, fix: "a-mcp" }] };
    w.health = { ok: true, version: "1", admin: "http://a.localdomain/admin", deployed: { branch: "main", commit: "abcdef0", at: "2026-11-15T12:00:00Z" } };
    await poller.poll();
    const findings = poller.snapshot!.findings;
    expect(findings.find((f) => f.id === "down:b-mcp")).toMatchObject({ summary: "b-mcp isn't listing its tools.", detail: expect.stringContaining("ECONNREFUSED") });
    expect(findings.find((f) => f.id === "subscriber-blocked:a-mcp")).toMatchObject({ summary: "A is blocked on the terminology.", detail: "scheme s gone at 10.0.0.9" });

    const server = await serveHttp(poller, { host: "127.0.0.1", port: 0, stateDir: "/nonexistent", access: NO_TEAM });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const tunnel = await fetch(`${base}/`, { headers: { "cf-ray": "x" } });
      expect(tunnel.status).toBe(200);
      const open = await tunnel.text();
      expect(open).toContain("b-mcp isn&#39;t listing its tools.");
      expect(open).toContain("joins: 2 found.");
      for (const hidden of ["ECONNREFUSED", "10.0.0.9", "localdomain", "http://h/worklist", "/admin", "/api/status", "Poll now", "github.com"]) expect(open).not.toContain(hidden);
      expect(open).toContain(`<a href="https://a.example/">a-mcp</a>`);
      // The portal's web page, not its MCP address, which a browser can't open.
      expect(open).toContain(`<a href="https://portal.example/">portal.example</a>`);
      expect(open).not.toContain(`href="https://portal.example/mcp"`);
      expect((await fetch(`${base}/`, { headers: { "cf-ray": "x", "cf-access-jwt-assertion": "forged" } })).status).toBe(503);
      expect((await fetch(`${base}/`, { method: "POST", headers: { "cf-ray": "x" } })).status).toBe(405);

      expect(await (await fetch(`${base}/`)).text()).toContain(`<a href="/admin">admin</a>`);
      const admin = await (await fetch(`${base}/admin`)).text();
      for (const shown of ["ECONNREFUSED", "10.0.0.9", "http://a.localdomain/admin", "http://h/worklist", "Poll now", "https://github.com/me/a-mcp/commit/abcdef0", `<a href="https://portal.example/">The portal</a>`]) expect(admin).toContain(shown);

      const polled = poller.snapshot!.polled_at;
      w.tick(1);
      const post = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers, redirect: "manual" });
      // The form needs a browser's word that it came from this page; another site's, or none at all, is refused.
      expect((await post("/admin/poll", { origin: "http://evil.example" })).status).toBe(403);
      expect((await post("/admin/poll", { origin: "null" })).status).toBe(403);
      expect((await post("/admin/poll", { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await post("/admin/poll", {})).status).toBe(403);
      // /api/poll is for curl, but not a way round that.
      expect((await post("/api/poll", { origin: "http://evil.example" })).status).toBe(403);
      expect((await post("/api/poll", { "sec-fetch-site": "same-site" })).status).toBe(403);
      expect(poller.snapshot!.polled_at).toBe(polled);
      expect((await post("/admin/poll", { "sec-fetch-site": "same-origin" })).status).toBe(303);
      expect((await post("/api/poll", {})).status).toBe(200);
      const posted = await fetch(`${base}/admin/poll`, { method: "POST", headers: { origin: base }, redirect: "manual" });
      expect([posted.status, posted.headers.get("location")]).toEqual([303, "/admin"]);
      expect(poller.snapshot!.polled_at).not.toBe(polled);
      expect((await fetch(`${base}/admin/poll`, { method: "POST", headers: { "cf-ray": "x" } })).status).toBe(401);
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
