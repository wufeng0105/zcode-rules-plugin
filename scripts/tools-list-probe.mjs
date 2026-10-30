// MCP tools/list 探针（stdio 管道法，与已验证的 write-path-proof 同款）
// 用法：node tools-list-probe.mjs <server.mjs 路径> <dataDir>
//
// 关键点（实测踩坑）：
//  1) **必须串行**：先 await initialize 的回包，再发 notifications/initialized，
//     最后再发 tools/list。一次性连发三条会拿不到 tools 回包（实测）。
//  2) 必须显式 `stdio: ["pipe","pipe","pipe"]`。
//  3) 不要用 `cmd /c` 重定向 —— cmd 的参数解析会把 `<`/`>` 当普通参数（实测两次失败）。
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [, , serverPath, dataDir] = process.argv;
const p = spawn(process.execPath, [resolve(serverPath)], {
  env: { ...process.env, ZCODE_RULES_DATA: resolve(dataDir) },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const lines = [];
let buf = "";
const pending = new Map();
let nextId = 0;
p.stdout.setEncoding("utf8");
p.stderr.setEncoding("utf8");
p.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    lines.push(line);
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    } catch {}
  }
});
p.stderr.on("data", (c) => {
  for (const l of String(c).split("\n")) if (l.trim()) lines.push(l);
});

const rpc = (method, params) =>
  new Promise((res) => {
    const mid = ++nextId;
    pending.set(mid, res);
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mid, method, params })}\n`);
    setTimeout(() => res({ __timeout: true }), 8000);
  });

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0.1" } });
p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
const list = await rpc("tools/list", {});
p.stdin.end();
p.kill();

const names = (list?.result?.tools ?? []).map((t) => t.name);
const dataDirSeen = /dataDir=(.+?)(?:\s|$)/.exec(lines.join("\n"))?.[1] ?? "?";
console.log(`tools=${names.length} ${names.join(",")}`);
console.log(`dataDir=${dataDirSeen}`);
if (!names.length) console.error(`[probe] 收到 ${lines.length} 行，未见 tools 回包：\n${lines.slice(0, 4).join("\n").slice(0, 400)}`);
process.exit(names.length >= 6 ? 0 : 1);
