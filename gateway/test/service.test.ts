import { describe, expect, test } from "bun:test";
import { renderLaunchd, renderSystemd, type Ctx } from "../src/service";

const ctx: Ctx = {
  home: "/home/u",
  bun: "/home/u/.local/share/mise/shims/bun",
  app: "/home/u/.local/share/subagent-models/app",
  path: "/home/u/.local/bin:/usr/bin:/bin",
  ompWatch: ["/usr/local/bin/omp", "/home/u/.omp/agent/last-changelog-version"],
};

describe("service files", () => {
  test("systemd units run the linked app with bun", () => {
    const u = renderSystemd(ctx);
    expect(Object.keys(u).sort()).toEqual([
      "subagent-models-omp-sync.path", "subagent-models-omp-sync.service", "subagent-models-omp-sync.timer", "subagent-models.service",
    ]);
    expect(u["subagent-models.service"]).toContain("ExecStart=/home/u/.local/share/mise/shims/bun /home/u/.local/share/subagent-models/app/gateway/src/cli.ts serve");
    expect(u["subagent-models.service"]).toContain("Restart=always");
    expect(u["subagent-models-omp-sync.path"]).toContain("PathChanged=/usr/local/bin/omp");
  });

  test("launchd agents keep the gateway alive and log to ~/Library/Logs", () => {
    const p = renderLaunchd(ctx, "/home/u/Library/Logs/subagent-models");
    const g = p["subagent-models.gateway.plist"]!;
    expect(g).toContain("<string>subagent-models.gateway</string>");
    expect(g).toMatch(/<string>\/home\/u\/.local\/share\/mise\/shims\/bun<\/string>\s*<string>[^<]*cli.ts<\/string>\s*<string>serve<\/string>/);
    expect(g).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(g).toContain("/home/u/Library/Logs/subagent-models/gateway.log");
    const s = p["subagent-models.omp-sync.plist"]!;
    expect(s).toContain("<key>StartInterval</key>\n  <integer>600</integer>");
    expect(s).toContain("<string>/usr/local/bin/omp</string>");
  });
});
