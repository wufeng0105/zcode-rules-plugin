// scripts/ 下两个静态校验脚本的回归测试：证明它们**会红**（非恒真）。
//
// 为什么必须测「红」：一个永远 exit 0 的校验脚本比没有脚本更糟——它给出虚假的安全感。
// 这里每个用例都成对出现：正常输入必须绿，变异输入必须红。
//
// 纪律：全部夹具落在 os.tmpdir()，不写仓库、不碰 ZCode 检出、不联网、不起 ZCode CLI。
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIDELITY_SCRIPT = join(REPO_ROOT, "scripts", "verify-fidelity.mjs");
const DOCS_SCRIPT = join(REPO_ROOT, "scripts", "check-docs.mjs");
const REFERENCE_FILES = [
  "src/rules/rules-engine.mjs",
  "src/rules/agents-section.mjs",
  "src/rules/export-agents.mjs",
  "src/hooks/permission-rules.mjs",
];

/** docs/selfcheck 下的副本与 src/ 原件的对应关系（verify-fidelity 校验这一致性）。 */
const COPY_PAIRS = [
  ["docs/selfcheck/rules/rules-engine.mjs", "src/rules/rules-engine.mjs"],
  ["docs/selfcheck/rules/agents-section.mjs", "src/rules/agents-section.mjs"],
  ["docs/selfcheck/rules/export-agents.mjs", "src/rules/export-agents.mjs"],
  ["docs/selfcheck/hooks/permission-rules.mjs", "src/hooks/permission-rules.mjs"],
];

const tempRoots = [];
function tempRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `zcode-rules-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) rmSync(dir, { force: true, recursive: true });
});

/** 跑一个脚本，返回 { status, output }。 */
function runScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
  return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status };
}

/** 复制 4 个参照实现到临时根（内容可被按需篡改）。 */
function seedReferenceTree(root) {
  for (const rel of REFERENCE_FILES) {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(REPO_ROOT, ...rel.split("/"))));
  }
  // 副本也要在临时根里（verify-fidelity 现在同时校验「副本 ≡ 原件」）
  for (const [copyRel, originRel] of COPY_PAIRS) {
    const copyTarget = join(root, ...copyRel.split("/"));
    mkdirSync(dirname(copyTarget), { recursive: true });
    writeFileSync(copyTarget, readFileSync(join(root, ...originRel.split("/"))));
  }
}

describe("verify-fidelity.mjs（参照实现保真）", () => {
  test("真实工作树：4 个参照实现与基线全等 → exit 0", () => {
    const run = runScript(FIDELITY_SCRIPT, []);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /4 个参照实现逐字节一致/u);
    for (const rel of REFERENCE_FILES) assert.match(run.output, new RegExp(`ok    ${rel.replace(/\./gu, "\\.")}`, "u"));
  });

  test("变异①：基线里一条 sha256 改错一位 → exit 1（证明非恒真）", () => {
    const root = tempRoot("fid-bad-sha");
    seedReferenceTree(root);
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "FIDELITY.json"), "utf8"));
    const key = REFERENCE_FILES[0];
    const lastChar = baseline[key].slice(-1);
    baseline[key] = `${baseline[key].slice(0, -1)}${lastChar === "0" ? "1" : "0"}`;
    const manifest = join(root, "FIDELITY.json");
    writeFileSync(manifest, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const run = runScript(FIDELITY_SCRIPT, ["--root", root, "--manifest", manifest]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /FAIL  src\/rules\/rules-engine\.mjs/u);
    assert.match(run.output, /1 个文件与基线不一致/u);
  });

  test("变异②：参照实现本身被改一个字节 → exit 1", () => {
    const root = tempRoot("fid-tampered");
    seedReferenceTree(root);
    const victim = join(root, ...REFERENCE_FILES[1].split("/"));
    writeFileSync(victim, `${readFileSync(victim, "utf8")}\n// tampered\n`, "utf8");

    const run = runScript(FIDELITY_SCRIPT, ["--root", root]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /FAIL  src\/rules\/agents-section\.mjs/u);
  });

  test("变异③：docs/selfcheck 副本被改（原件不动）→ exit 1（防两份参照实现悄悄漂移）", () => {
    const root = tempRoot("fid-copy-drift");
    seedReferenceTree(root);
    const [copyRel] = COPY_PAIRS[0];
    const copyTarget = join(root, ...copyRel.split("/"));
    writeFileSync(copyTarget, `${readFileSync(copyTarget, "utf8")}\n// copy drift\n`, "utf8");

    const run = runScript(FIDELITY_SCRIPT, ["--root", root]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /FAIL  docs\/selfcheck\/rules\/rules-engine\.mjs/u);
    assert.match(run.output, /副本必须与 src\/ 原件逐字节相同/u);
  });

  test("fail-closed：副本缺失 → exit 1 并点名（不静默跳过副本检查）", () => {
    const root = tempRoot("fid-copy-missing");
    seedReferenceTree(root);
    rmSync(join(root, ...COPY_PAIRS[1][0].split("/")), { force: true });

    const run = runScript(FIDELITY_SCRIPT, ["--root", root]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /FAIL  docs\/selfcheck\/rules\/agents-section\.mjs/u);
    assert.match(run.output, /文件缺失/u);
  });

  test("fail-closed：基线少一条（删掉一条只留 3 条）→ exit 1，不报「全部一致」", () => {
    const root = tempRoot("fid-missing-entry");
    seedReferenceTree(root);
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "FIDELITY.json"), "utf8"));
    delete baseline[REFERENCE_FILES[3]];
    const manifest = join(root, "FIDELITY.json");
    writeFileSync(manifest, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const run = runScript(FIDELITY_SCRIPT, ["--root", root, "--manifest", manifest]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /基线缺少条目/u);
    assert.doesNotMatch(run.output, /逐字节一致/u);
  });

  test("fail-closed：基线多出清单外条目 → exit 1（清单是代码常量，不接受扩张）", () => {
    const root = tempRoot("fid-extra-entry");
    seedReferenceTree(root);
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "FIDELITY.json"), "utf8"));
    baseline["src/rules/sections.mjs"] = "0".repeat(64);
    const manifest = join(root, "FIDELITY.json");
    writeFileSync(manifest, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const run = runScript(FIDELITY_SCRIPT, ["--root", root, "--manifest", manifest]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /清单外条目/u);
  });

  test("fail-closed：基线不是合法 JSON → exit 1", () => {
    const root = tempRoot("fid-bad-json");
    seedReferenceTree(root);
    const manifest = join(root, "FIDELITY.json");
    writeFileSync(manifest, "{ 不是 JSON", "utf8");

    const run = runScript(FIDELITY_SCRIPT, ["--root", root, "--manifest", manifest]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /基线不是合法 JSON/u);
  });

  test("参照实现缺失 → exit 1，并点名缺失文件", () => {
    const root = tempRoot("fid-missing-file");
    seedReferenceTree(root);
    rmSync(join(root, ...REFERENCE_FILES[2].split("/")), { force: true });

    const run = runScript(FIDELITY_SCRIPT, ["--root", root]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /FAIL  src\/rules\/export-agents\.mjs/u);
    assert.match(run.output, /文件缺失/u);
  });

  test("--list 打印实测 sha256（不比对），与 FIDELITY.json 一致", () => {
    const run = runScript(FIDELITY_SCRIPT, ["--list"]);
    assert.equal(run.status, 0, run.output);
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "FIDELITY.json"), "utf8"));
    for (const [rel, expected] of Object.entries(baseline)) {
      assert.ok(run.output.includes(expected), `--list 应输出 ${rel} 的实测值 ${expected}`);
    }
  });
});

describe("check-docs.mjs（文档引用）", () => {
  /** 造一个最小文档树：docs/guide.md 存在，LICENSE 存在。 */
  function seedDocsTree() {
    const root = tempRoot("docs");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "LICENSE"), "MIT\n", "utf8");
    writeFileSync(join(root, "docs", "guide.md"), "# guide\n", "utf8");
    return root;
  }

  test("真实仓库：README/CHANGELOG 引用全部存在 → exit 0", () => {
    const run = runScript(DOCS_SCRIPT, []);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /全部存在/u);
  });

  test("红：临时加一个不存在的相对链接 → exit 1（证明非恒真）", () => {
    const root = seedDocsTree();
    writeFileSync(
      join(root, "README.md"),
      "# t\n\n[LICENSE](LICENSE)\n[坏链](docs/does-not-exist.md)\n",
      "utf8",
    );

    const run = runScript(DOCS_SCRIPT, ["--root", root, "README.md"]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /链接目标不存在：docs\/does-not-exist\.md/u);
  });

  test("绿：同一份文档去掉坏链 → exit 0（红绿对照，排除「一律红」）", () => {
    const root = seedDocsTree();
    writeFileSync(join(root, "README.md"), "# t\n\n[LICENSE](LICENSE)\n[指南](docs/guide.md)\n", "utf8");
    const run = runScript(DOCS_SCRIPT, ["--root", root, "README.md"]);
    assert.equal(run.status, 0, run.output);
  });

  test("红：反引号里的仓库内路径不存在 → exit 1", () => {
    const root = seedDocsTree();
    writeFileSync(join(root, "README.md"), "见 `src/missing.mjs` 与 `docs/guide.md`\n", "utf8");

    const run = runScript(DOCS_SCRIPT, ["--root", root, "README.md"]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /代码引用路径不存在：src\/missing\.mjs/u);
  });

  test("围栏代码块里的路径不算引用（示例不是引用）", () => {
    const root = seedDocsTree();
    writeFileSync(
      join(root, "README.md"),
      "# t\n\n```text\nsrc/nowhere.mjs\n```\n\n[LICENSE](LICENSE)\n",
      "utf8",
    );
    const run = runScript(DOCS_SCRIPT, ["--root", root, "README.md"]);
    assert.equal(run.status, 0, run.output);
  });

  test("http 外链不查（CI 不联网，外链腐烂与本仓库交付无关）", () => {
    const root = seedDocsTree();
    writeFileSync(
      join(root, "README.md"),
      "# t\n\n[上游](https://example.invalid/nope)\n[LICENSE](LICENSE)\n",
      "utf8",
    );
    const run = runScript(DOCS_SCRIPT, ["--root", root, "README.md"]);
    assert.equal(run.status, 0, run.output);
  });

  test("纯锚点与 mailto 不查", () => {
    const root = seedDocsTree();
    writeFileSync(join(root, "README.md"), "# t\n\n[跳转](#section)\n[写信](mailto:a@b.c)\n", "utf8");
    const run = runScript(DOCS_SCRIPT, ["--root", root, "README.md"]);
    assert.equal(run.status, 0, run.output);
  });

  test("外部前缀（docs/zcode-mod/）跳过但打印 SKIP，跳过可见", () => {
    const root = seedDocsTree();
    writeFileSync(
      join(root, "README.md"),
      "来源 `docs/zcode-mod/selfcheck/rules/rules-engine.mjs`\n",
      "utf8",
    );
    const run = runScript(DOCS_SCRIPT, ["--root", root, "README.md"]);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /SKIP  /u);
    assert.match(run.output, /只读 ZCode 检出/u);
  });

  test("受检文档本身不存在 → exit 1（不会静默跳过整篇）", () => {
    const root = seedDocsTree();
    const run = runScript(DOCS_SCRIPT, ["--root", root, "MISSING.md"]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /受检文档不存在/u);
  });
});
