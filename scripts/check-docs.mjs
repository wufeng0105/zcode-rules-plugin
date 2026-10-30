#!/usr/bin/env node
// 文档链接/文件引用检查（纯静态，无网络，零依赖）。
//
// 查什么：
//   · Markdown 里的相对链接 `[text](target)` 与相对图片 `![alt](target)` —— 目标必须存在
//   · 反引号里的仓库内路径引用（如 `` `docs/zcode-mod/isolation/RECIPE.md` ``、
//     `` `src/rules/sections.mjs` ``、`` `tests/panel.test.mjs` ``）—— 必须存在
//
// 不查什么（故意，且每条都有理由）：
//   · http/https 外链：需要网络，CI 不联网；外链腐烂与本仓库能否交付无关
//   · 纯锚点 `#section`、`mailto:`、其他 URI scheme
//   · 围栏代码块（``` / ~~~）内部的示例路径：那里是**示意**，不是引用
//   · 反斜杠路径（`.zhll\rt\...`）：那是 **ZCode 检出内**的 gitignored 证据路径，
//     本仓库里不存在也不该存在；本仓库一律用正斜杠
//   · EXTERNAL_PREFIXES 命中的前缀（如 `docs/zcode-mod/...` = 只读 ZCode 检出文档）：
//     跳过但**逐条打印 SKIP 行**，跳过可见，不是静默放行
//
// 为什么「消失的引用」也算失败：README/CHANGELOG 是对外契约的一部分。改了文件却忘了改
// 文档，读者点进去 404 —— 这类腐烂靠人眼复查抓不住，只能靠脚本。
//
// 用法：
//   node scripts/check-docs.mjs                # 默认检查 README.md / CHANGELOG.md / LICENSE 等
//   node scripts/check-docs.mjs --root <dir>   # 换根（单测用）
//   node scripts/check-docs.mjs README.md ...  # 只查指定文件（路径相对 --root）
//
// 退出码：0 全部存在 / 1 有缺失或读失败 / 2 参数错
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

// 默认受检文档：对外可见、且引用仓库内文件的那几份。
const DEFAULT_DOCS = Object.freeze(["README.md", "CHANGELOG.md"]);

// 反引号引用里允许的"仓库内路径"形态：必须像路径（至少一段 + 斜杠 + 已知扩展名/文件名），
// 且**不以**这些开头（那些是命令、变量、URL、占位符，不是文件引用）。
const BACKTICK_PATH_RE = /^[A-Za-z0-9_.][A-Za-z0-9_./@-]*\.(?:mjs|js|json|md|html|txt|yml|yaml)$/u;
const BACKTICK_STOP_PREFIXES = ["http", "node ", "$", "-", "<"];

// 外部引用前缀：这些路径**属于只读的 ZCode 检出，永远不可能出现在本仓库**。
// 例：README「来源与保真」表里的 `docs/zcode-mod/selfcheck/rules/rules-engine.mjs`，
// 它描述的是复制来源，不是本仓库文件。把它们当缺失就是假红。
//
// 这一条是**显式清单**而不是"猜"：新增外部前缀必须写明理由并落到这里；
// 被跳过的引用会以 `SKIP` 行打印出来（跳过可见，不是静默放行）。
const EXTERNAL_PREFIXES = Object.freeze([
  { prefix: "docs/zcode-mod/", reason: "只读 ZCode 检出的文档目录（含 selfcheck/ 参照实现来源、isolation/ 配方）" },
]);

function parseArgs(argv) {
  const opts = { root: REPO_ROOT, files: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") opts.root = resolve(argv[(i += 1)] ?? "");
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "用法: node scripts/check-docs.mjs [--root <dir>] [文件...]\n默认文件: " +
          `${DEFAULT_DOCS.join(" ")}\n`,
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      process.stderr.write(`未知参数：${arg}\n`);
      process.exit(2);
    } else rest.push(arg);
  }
  if (rest.length > 0) opts.files = rest;
  return opts;
}

/** 去掉围栏代码块（``` / ~~~），保留行号：被去掉的行替换成空行，行号不漂移。 */
function stripFencedCode(text) {
  const lines = text.split(/\r?\n/u);
  const out = [];
  let fence = null;
  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence === null) {
      if (match) {
        fence = match[1][0];
        out.push("");
      } else out.push(line);
    } else {
      if (match && match[1][0] === fence && match[2].trim() === "") fence = null;
      out.push("");
    }
  }
  return out;
}

/** 行内反引号：返回 [{ code, index }]，支持 `` ` `` 与 ``` `` ``` 两种围栏。 */
function inlineCodes(line) {
  const out = [];
  const re = /(`+)([^`]*?)\1/gu;
  let match;
  while ((match = re.exec(line)) !== null) out.push({ code: match[2].trim(), index: match.index });
  return out;
}

/** 判断一个链接目标是否需要在仓库内存在，返回 { target, kind } 或 null（跳过）。 */
function resolveLinkTarget(rawTarget) {
  const target = rawTarget.trim();
  if (target === "") return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(target)) return null; // http:, mailto:, data: ...
  if (target.startsWith("#")) return null; // 纯锚点
  if (target.startsWith("//")) return null; // 协议相对
  // 去掉标题 `path "title"` 与锚点 `path#frag`、查询 `path?x`
  let cleaned = target.split(/\s+/u)[0];
  const hashAt = cleaned.indexOf("#");
  if (hashAt >= 0) cleaned = cleaned.slice(0, hashAt);
  const queryAt = cleaned.indexOf("?");
  if (queryAt >= 0) cleaned = cleaned.slice(0, queryAt);
  if (cleaned === "") return null;
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    /* 非法 % 编码：按原样查，让它自然失败 */
  }
  return cleaned;
}

function checkDoc(opts) {
  const problems = [];
  const skipped = [];
  for (const docRel of opts.files ?? DEFAULT_DOCS) {
    const docPath = isAbsolute(docRel) ? docRel : join(opts.root, docRel);
    if (!existsSync(docPath) || !statSync(docPath).isFile()) {
      problems.push({ doc: docRel, line: 0, detail: `受检文档不存在：${docPath}`, kind: "doc-missing" });
      continue;
    }
    const text = readFileSync(docPath, "utf8");
    const docDir = dirname(docPath);
    const lines = stripFencedCode(text);

    lines.forEach((line, i) => {
      const lineNo = i + 1;

      // 1) Markdown 链接 / 图片：`[t](target)` / `![t](target)`；引用式定义 `[id]: target` 也查
      const linkRe = /(!?)\[[^\]]*\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/gu;
      let match;
      while ((match = linkRe.exec(line)) !== null) {
        const kind = match[1] === "!" ? "image" : "link";
        const cleaned = resolveLinkTarget(match[2]);
        if (cleaned === null) continue;
        const abs = isAbsolute(cleaned) ? cleaned : resolve(docDir, cleaned);
        if (!existsSync(abs)) {
          problems.push({ doc: docRel, line: lineNo, detail: `链接目标不存在：${match[2]} → ${abs}`, kind });
        }
      }
      const refRe = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/u;
      const refMatch = refRe.exec(line);
      if (refMatch) {
        const cleaned = resolveLinkTarget(refMatch[1]);
        if (cleaned !== null) {
          const abs = isAbsolute(cleaned) ? cleaned : resolve(docDir, cleaned);
          if (!existsSync(abs)) {
            problems.push({ doc: docRel, line: lineNo, detail: `引用式链接目标不存在：${refMatch[1]} → ${abs}`, kind: "ref-link" });
          }
        }
      }

      // 2) 反引号里的仓库内路径引用
      for (const { code } of inlineCodes(line)) {
        if (code === "" || code.includes(" ")) continue;
        if (BACKTICK_STOP_PREFIXES.some((p) => code.startsWith(p))) continue;
        if (!BACKTICK_PATH_RE.test(code)) continue;
        // 只接受含斜杠的形态（`README.md` 这类裸文件名在正文里多是泛指，不当作引用）
        if (!code.includes("/")) continue;
        const external = EXTERNAL_PREFIXES.find((entry) => code.startsWith(entry.prefix));
        if (external) {
          skipped.push({ line: lineNo, doc: docRel, reason: external.reason, ref: code });
          continue;
        }
        const abs = resolve(docDir, code);
        if (!existsSync(abs)) {
          problems.push({ doc: docRel, line: lineNo, detail: `代码引用路径不存在：${code} → ${abs}`, kind: "code-ref" });
        }
      }
    });
  }
  return { problems, skipped };
}

const opts = parseArgs(process.argv.slice(2));
process.stdout.write(`# 文档引用检查\n# root=${opts.root}\n# files=${(opts.files ?? DEFAULT_DOCS).join(", ")}\n`);
const { problems, skipped } = checkDoc(opts);

for (const entry of skipped) {
  process.stdout.write(`SKIP  ${entry.doc}:${entry.line}  ${entry.ref}（${entry.reason}）\n`);
}

if (problems.length === 0) {
  process.stdout.write(
    `结论：受检文档里的相对链接与仓库内路径引用全部存在（跳过 ${skipped.length} 处外部引用，exit 0）\n`,
  );
  process.exit(0);
}

for (const problem of problems) {
  const where = problem.line > 0 ? `${problem.doc}:${problem.line}` : problem.doc;
  process.stdout.write(`FAIL  ${where}  ${problem.detail}\n`);
}
process.stdout.write(`结论：${problems.length} 处引用缺失（exit 1）\n`);
process.exit(1);
