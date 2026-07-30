import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = join(projectDir, "sidecar");

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: projectDir,
      env: {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: join(sidecarDir, ".venv"),
        UV_CACHE_DIR: join(sidecarDir, ".uv-cache"),
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${signal || code}`));
    });
  });
}

await run("uv", ["python", "install", "3.11"]);
await run("uv", [
  "sync",
  "--project",
  sidecarDir,
  "--python",
  "3.11",
  "--group",
  "dev",
  "--extra",
  "models",
  "--locked",
]);
await run("uv", [
  "run",
  "--project",
  sidecarDir,
  "--no-sync",
  "python",
  "-m",
  "cowart_sidecar.model_setup",
]);
