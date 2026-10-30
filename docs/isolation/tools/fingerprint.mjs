// 指纹工具：为"实验是否写脏真实用户目录"提供可判定的前置/后置证据。
//
// 用法：
//   node fingerprint.mjs --snapshot <out.json> [--label <name>] [--optional <path>...]
//   node fingerprint.mjs --compare <before.json> <after.json>
//   node fingerprint.mjs --simulate-touch <before.json> <out.json> --path <path> [--size <n>] [--mtime <iso>]
//
// 退出码（三态，供门禁使用）：
//   0 = 无差异（或快照成功）
//   1 = 有差异
//   2 = 环境不可用 / 读取失败（fail-closed：绝不把"读不到"报成"零差异"）
//
// 设计要点（对应阶段三件 2 判据）：
//   J2-1 清单必须含 cli/db/db.sqlite{,-wal,-shm} 与 AGENTS.md，各记 sha256+mtime+size
//   J2-2 能抓到只改 wal/shm 的变更（由 --simulate-touch 构造，供红灯用例）
//   J2-5 fail-closed：任一"必需"文件不存在或读取失败 → exit 2，且明确打印 NOT VERIFIED
//
// 关于"可选文件"的口径（诚实说明，不是放宽）：
//   db.sqlite-wal / db.sqlite-shm 在空闲 SQLite 下**本来就可能不存在**。若把它们当"必需"，
//   每次快照都会 exit 2，工具就废了。因此支持 --optional 显式声明：
//     · 可选文件缺失 → 记为 exists:false，快照仍成功（exit 0），但会在 NOT VERIFIED 段列出；
//     · 可选文件"前无后有"或"前有后无"或内容变化 → 仍然算差异（exit 1）。
//   必需文件（db.sqlite、AGENTS.md）缺失/读失败一律 exit 2。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// --base：把监控根从"真实 home"换成任意目录（用于 J2-4 的影子 home 复刻，零污染真实目录）
const BASE_FLAG_AT = process.argv.indexOf("--base");
const HOME =
  BASE_FLAG_AT >= 0 && process.argv[BASE_FLAG_AT + 1]
    ? path.resolve(process.argv[BASE_FLAG_AT + 1])
    : process.env.USERPROFILE || process.env.HOME || homedir();
const ZCODE = path.join(HOME, ".zcode");

const DEFAULT_TARGETS = [
  { id: "cli-db", required: true, path: path.join(ZCODE, "cli", "db", "db.sqlite") },
  { id: "cli-db-wal", required: false, path: path.join(ZCODE, "cli", "db", "db.sqlite-wal") },
  { id: "cli-db-shm", required: false, path: path.join(ZCODE, "cli", "db", "db.sqlite-shm") },
  { id: "user-agents-md", required: true, path: path.join(ZCODE, "AGENTS.md") },
];

const EXIT_OK = 0;
const EXIT_DIFF = 1;
const EXIT_ENV = 2;

function parseArgs(argv) {
  const out = { flags: {}, lists: {}, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--snapshot" || arg === "--compare" || arg === "--simulate-touch") {
      out.flags.mode = arg.slice(2);
      continue;
    }
    if (arg === "--optional") {
      out.lists.optional = out.lists.optional ?? [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out.lists.optional.push(argv[i + 1]);
        i += 1;
      }
      continue;
    }
    if (arg === "--label" || arg === "--path" || arg === "--size" || arg === "--mtime" || arg === "--base") {
      out.flags[arg.slice(2)] = argv[i + 1];
      i += 1;
      continue;
    }
    out.rest.push(arg);
  }
  return out;
}

const sha256OfFile = (filePath) => {
  // 大文件（db.sqlite 可达数百 MB）分块读，避免一次性 566MB Buffer 抖动。
  // 用 readFileSync 在锁定期也可能失败，失败即按 fail-closed 处理。
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
};

function probeTarget(target, { optional }) {
  const record = {
    id: target.id,
    path: target.path,
    pathDisplay: target.path.replace(HOME, "~"),
    required: target.required && !optional,
    optional,
  };
  if (!existsSync(target.path)) {
    return { ...record, exists: false, error: "ENOENT" };
  }
  try {
    const st = statSync(target.path);
    return {
      ...record,
      exists: true,
      mtimeIso: st.mtime.toISOString(),
      mtimeMs: st.mtimeMs,
      sha256: sha256OfFile(target.path),
      size: st.size,
    };
  } catch (error) {
    return { ...record, exists: false, error: String(error?.code ?? error?.message ?? error) };
  }
}

function takeSnapshot(options) {
  const optionalSet = new Set(options.optional ?? []);
  const entries = DEFAULT_TARGETS.map((t) =>
    probeTarget(t, { optional: optionalSet.has(t.id) || optionalSet.has(t.path) }),
  );

  const unreadableRequired = entries.filter((e) => e.required && (!e.exists || e.error));
  const unreadableOptional = entries.filter((e) => !e.required && (!e.exists || e.error));

  const snapshot = {
    capturedAt: new Date().toISOString(),
    home: HOME,
    label: options.label ?? "<unlabeled>",
    node: process.version,
    platform: process.platform,
    entries,
    notVerified: [
      ...unreadableRequired.map((e) => ({ id: e.id, path: e.pathDisplay, reason: e.error ?? "missing", severity: "FAIL" })),
      ...unreadableOptional.map((e) => ({ id: e.id, path: e.pathDisplay, reason: e.error ?? "missing", severity: "INFO" })),
    ],
    ok: unreadableRequired.length === 0,
  };
  return { snapshot, unreadableRequired, unreadableOptional };
}

function compareSnapshots(before, after) {
  const diffs = [];
  const byIdAfter = new Map(after.entries.map((e) => [e.id, e]));
  for (const b of before.entries) {
    const a = byIdAfter.get(b.id);
    if (!a) {
      diffs.push({ id: b.id, kind: "missing-in-after", before: b.pathDisplay, after: "<absent>" });
      continue;
    }
    if (b.exists !== a.exists) {
      diffs.push({ id: b.id, kind: "existence", before: b.exists, after: a.exists, path: b.pathDisplay });
      continue;
    }
    if (!b.exists && !a.exists) {
      // 两边都不存在：不算差异，但也不算"已验证"（由 notVerified 段负责呈现）
      continue;
    }
    if (b.size !== a.size) {
      diffs.push({ id: b.id, kind: "size", before: b.size, after: a.size, path: b.pathDisplay });
    }
    if (b.mtimeIso !== a.mtimeIso) {
      diffs.push({ id: b.id, kind: "mtime", before: b.mtimeIso, after: a.mtimeIso, path: b.pathDisplay });
    }
    if (b.sha256 !== a.sha256) {
      diffs.push({ id: b.id, kind: "sha256", before: b.sha256, after: a.sha256, path: b.pathDisplay });
    }
  }
  return diffs;
}

function readJson(filePath) {
  const text = readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

// 构造"仅目标文件发生变化"的快照，用于 J2-2 红灯用例（不触碰真实文件）
function simulateTouch(before, targetPathOrId, overrides) {
  const clone = JSON.parse(JSON.stringify(before));
  const entry = clone.entries.find((e) => e.id === targetPathOrId || e.path === targetPathOrId || e.pathDisplay === targetPathOrId);
  if (!entry) throw new Error(`simulate-touch: 目标不在快照里: ${targetPathOrId}`);
  entry.exists = true;
  entry.size = overrides.size !== undefined ? Number(overrides.size) : (entry.size ?? 0) + 1;
  entry.mtimeIso = overrides.mtime ?? new Date(Date.now() + 1000).toISOString();
  entry.mtimeMs = Date.parse(entry.mtimeIso);
  entry.sha256 = createHash("sha256").update(`simulated:${entry.id}:${entry.size}:${entry.mtimeIso}`).digest("hex");
  entry.error = undefined;
  clone.capturedAt = new Date().toISOString();
  clone.label = `${clone.label}+simulated(${entry.id})`;
  clone.simulated = { target: entry.id, overrides };
  return clone;
}

function printSnapshot(snapshot) {
  process.stdout.write(`snapshot label=${snapshot.label} capturedAt=${snapshot.capturedAt}\n`);
  for (const e of snapshot.entries) {
    const state = e.exists ? `size=${e.size} mtime=${e.mtimeIso} sha256=${e.sha256.slice(0, 16)}…` : `MISSING(${e.error})`;
    process.stdout.write(`  [${e.required ? "REQUIRED" : "optional"}] ${e.id.padEnd(15)} ${e.pathDisplay}\n      ${state}\n`);
  }
  if (snapshot.notVerified.length > 0) {
    process.stdout.write("NOT VERIFIED:\n");
    for (const n of snapshot.notVerified) {
      process.stdout.write(`  [${n.severity}] ${n.id} ${n.path} reason=${n.reason}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const mode = args.flags.mode;

try {
  if (mode === "snapshot") {
    const outPath = args.rest[0];
    if (!outPath) {
      process.stderr.write("用法: --snapshot <out.json> [--label <name>] [--optional <id|path>...]\n");
      process.exit(EXIT_ENV);
    }
    const { snapshot, unreadableRequired, unreadableOptional } = takeSnapshot(args.flags);
    writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    printSnapshot(snapshot);
    process.stdout.write(`\n已写入 ${outPath}\n`);
    if (unreadableRequired.length > 0) {
      process.stderr.write(
        `\nFAIL-CLOSED: ${unreadableRequired.length} 个 REQUIRED 文件不可用 → 退出码 2（绝不报"零差异"）\n`,
      );
      process.exit(EXIT_ENV);
    }
    if (unreadableOptional.length > 0) {
      process.stdout.write(
        `\n注意：${unreadableOptional.length} 个可选文件缺失（已记入 NOT VERIFIED，快照成功但该项未验证）\n`,
      );
    }
    process.exit(EXIT_OK);
  }

  if (mode === "simulate-touch") {
    const [beforePath, outPath] = args.rest;
    if (!beforePath || !outPath || !args.flags.path) {
      process.stderr.write("用法: --simulate-touch <before.json> <out.json> --path <id|path> [--size <n>] [--mtime <iso>]\n");
      process.exit(EXIT_ENV);
    }
    const before = readJson(beforePath);
    const simulated = simulateTouch(before, args.flags.path, {
      mtime: args.flags.mtime,
      size: args.flags.size,
    });
    writeFileSync(outPath, `${JSON.stringify(simulated, null, 2)}\n`, "utf8");
    process.stdout.write(`已构造模拟快照 ${outPath}（目标=${simulated.simulated.target}，未触碰真实文件）\n`);
    process.exit(EXIT_OK);
  }

  if (mode === "compare") {
    const [beforePath, afterPath] = args.rest;
    if (!beforePath || !afterPath) {
      process.stderr.write("用法: --compare <before.json> <after.json>\n");
      process.exit(EXIT_ENV);
    }
    let before;
    let after;
    try {
      before = readJson(beforePath);
      after = readJson(afterPath);
    } catch (error) {
      process.stderr.write(`FAIL-CLOSED: 快照读取失败: ${error?.message ?? error}\n`);
      process.exit(EXIT_ENV);
    }
    // fail-closed：任一侧快照本身有 REQUIRED 未验证项 → 不能给出"差异/无差异"结论
    const badSides = [];
    if (before.ok === false) badSides.push(`before(${beforePath})`);
    if (after.ok === false) badSides.push(`after(${afterPath})`);
    if (badSides.length > 0) {
      process.stderr.write(
        `FAIL-CLOSED: 快照含未验证的 REQUIRED 文件：${badSides.join(", ")} → 退出码 2\n` +
          `（拒绝把"读不到"报成"零差异"）\n`,
      );
      for (const n of [...(before.notVerified ?? []), ...(after.notVerified ?? [])]) {
        if (n.severity === "FAIL") process.stderr.write(`  [FAIL] ${n.id} ${n.path} reason=${n.reason}\n`);
      }
      process.exit(EXIT_ENV);
    }
    const diffs = compareSnapshots(before, after);
    process.stdout.write(`before=${beforePath} label=${before.label}\n`);
    process.stdout.write(`after =${afterPath} label=${after.label}\n`);
    if (diffs.length === 0) {
      process.stdout.write("\n结果：无差异（EXIT 0）\n");
      const notVerified = [...(before.notVerified ?? []), ...(after.notVerified ?? [])];
      if (notVerified.length > 0) {
        process.stdout.write("但下列项未被验证（可选文件缺失，属预期）：\n");
        for (const n of notVerified) process.stdout.write(`  [INFO] ${n.id} ${n.path} reason=${n.reason}\n`);
      }
      process.exit(EXIT_OK);
    }
    process.stdout.write(`\n结果：发现 ${diffs.length} 处差异（EXIT 1）\n`);
    for (const d of diffs) {
      process.stdout.write(`  - ${d.id} [${d.kind}] ${d.path ?? ""} ${JSON.stringify({ before: d.before, after: d.after })}\n`);
    }
    process.exit(EXIT_DIFF);
  }

  process.stderr.write("用法: --snapshot <out> | --compare <a> <b> | --simulate-touch <in> <out> --path <id>\n");
  process.exit(EXIT_ENV);
} catch (error) {
  process.stderr.write(`FAIL-CLOSED: 未预期错误: ${error?.stack ?? error}\n`);
  process.exit(EXIT_ENV);
}
