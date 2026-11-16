import fs from "node:fs";
import path from "node:path";

/**
 * The little this server remembers between polls and restarts: since when each service has been up or down,
 * and when each finding was first seen. One small JSON file (OPS_STATE), rewritten when it changes. There is no
 * history beyond "since": uptime over time would want a database, and nothing asks for it yet.
 */

interface Data {
  services: Record<string, { up: boolean; since: string }>;
  findings: Record<string, string>;
}

export class Store {
  private data: Data = { services: {}, findings: {} };
  private saved = "";

  /** With no file, nothing is kept past the process (tests, `status` from a checkout). */
  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Data>;
      this.data = { services: raw.services ?? {}, findings: raw.findings ?? {} };
      this.saved = JSON.stringify(this.data);
    } catch { /* A first run, or a file cut short: start again; "since" restarts from now. */ }
  }

  /** Since when the service has been in this state. */
  since(name: string, up: boolean, at: string): string {
    const last = this.data.services[name];
    if (last?.up === up) return last.since;
    this.data.services[name] = { up, since: at };
    return at;
  }

  /** When the finding was first seen, in an unbroken run up to now. */
  firstSeen(id: string, at: string): string {
    return (this.data.findings[id] ??= at);
  }

  /** Forgets what is no longer there, so a finding that returns starts a new run. */
  keep(services: string[], findings: string[]): void {
    for (const name of Object.keys(this.data.services)) if (!services.includes(name)) delete this.data.services[name];
    for (const id of Object.keys(this.data.findings)) if (!findings.includes(id)) delete this.data.findings[id];
  }

  save(): void {
    if (!this.file) return;
    const body = JSON.stringify(this.data);
    if (body === this.saved) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.new`, body);
    fs.renameSync(`${this.file}.new`, this.file);
    this.saved = body;
  }
}
