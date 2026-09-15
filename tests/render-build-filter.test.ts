import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function renderBuildDecision(path: string): boolean {
  const result = spawnSync(
    "python",
    [
      "-c",
      [
        "import fnmatch, sys, yaml",
        "service = yaml.safe_load(open('render.yaml'))['services'][0]",
        "patterns = service.get('buildFilter', {}).get('paths', [])",
        "print(any(fnmatch.fnmatch(sys.argv[1], pattern) for pattern in patterns))",
      ].join("; "),
      path,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === "True";
}

test("frontend-only changes do not restart the Wisp service", () => {
  assert.equal(renderBuildDecision("index.tsx"), false);
});

test("Wisp runtime changes still deploy to Render", () => {
  assert.equal(renderBuildDecision("wisp-server.ts"), true);
  assert.equal(renderBuildDecision("api/_lib/session.ts"), true);
});
