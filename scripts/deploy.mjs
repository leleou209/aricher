import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const usePrivate = args.includes("--private");
const override = process.env.HR_DESK_WRANGLER_CONFIG;

if (
  args.some((arg) => arg !== "--dry-run" && arg !== "--private") ||
  new Set(args).size !== args.length
) {
  throw new Error("只支持 --dry-run 和 --private，每个参数最多一次。");
}
if (usePrivate !== Boolean(override)) {
  throw new Error(
    "私有配置部署必须同时设置 HR_DESK_WRANGLER_CONFIG 并传 --private；公开示例部署不得带私有配置。",
  );
}

const source = path.resolve(root, override || "wrangler.jsonc");
if (!existsSync(source)) throw new Error("Wrangler 配置文件不存在。");

function run(relativeBin, binArgs) {
  const result = spawnSync(process.execPath, [path.join(root, relativeBin), ...binArgs], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const startedAt = Date.now();
run("node_modules/vite/bin/vite.js", ["build"]);

// Worker 名更改后旧的 dist 目录可能仍在；只接受此次构建且来源配置一致的产物。
const dist = path.join(root, "dist");
const candidates = readdirSync(dist, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(dist, entry.name, "wrangler.json"))
  .filter((file) => existsSync(file) && statSync(file).mtimeMs >= startedAt - 1000)
  .map((file) => ({ file, config: JSON.parse(readFileSync(file, "utf8")) }))
  .filter(({ config }) => path.resolve(config.userConfigPath || "") === source);

if (candidates.length !== 1) {
  throw new Error("无法唯一确定本次构建对应的 Worker 配置，已停止部署。");
}
const { file, config } = candidates[0];
if (
  !usePrivate &&
  (config.name !== "ericher-app" ||
    config.routes?.length ||
    config.vars?.CF_ACCOUNT_ID)
) {
  throw new Error("公开构建混入私有部署标识，已停止部署。");
}

console.log(`已核对本次构建目标：${config.name}${dryRun ? "（仅 dry-run）" : ""}`);
run("node_modules/wrangler/bin/wrangler.js", [
  "deploy",
  "--config",
  file,
  ...(dryRun ? ["--dry-run"] : []),
]);
