// 自检探针：调用插件的 runSelfcheck 并打印各项（level/id/message）
// 用法：node scripts/probe-selfcheck.mjs <dataDir> <agentsPath> <configPath>
import { runSelfcheck } from "../src/mcp/operations.mjs";

const [dataDir, agentsPath, configPath] = process.argv.slice(2);
const sc = runSelfcheck({ dataDir, agentsPath, configPath });
for (const c of sc.checks) {
  console.log(`level=${c.level}\tid=${c.id}\t${c.message}`);
}
console.log(`summary\terrors=${sc.summary.errors}\twarnings=${sc.summary.warnings}\trulesCount=${sc.summary.rulesCount}\tversion=${sc.summary.version}`);
