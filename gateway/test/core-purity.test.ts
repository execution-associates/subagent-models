// The hosted service bundles gateway/src/core into a Cloudflare Worker: nothing it
// reaches may need Bun, Node or the file system.
import { expect, test } from "bun:test";

test("the core bundles for the browser with no node: imports or Bun APIs", async () => {
  const out = await Bun.build({ entrypoints: [`${import.meta.dir}/../src/core/index.ts`], target: "browser", format: "esm" });
  expect(out.logs.filter(l => l.level === "error").map(String)).toEqual([]);
  expect(out.success).toBe(true);
  const code = await out.outputs[0]!.text();
  expect(code).not.toMatch(/from\s*["']node:|require\(["']node:/);
  expect(code).not.toMatch(/\bBun\./);
  expect(code).not.toMatch(/\bprocess\.(env|platform|getuid|exit)/);
  expect(code).not.toMatch(/\bBuffer\./);
});
