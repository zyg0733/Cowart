import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = join(projectDir, "sidecar");
const child = spawn(
  "uv",
  ["run", "--project", sidecarDir, "--no-sync", "python", "-m", "cowart_sidecar.main"],
  {
    cwd: projectDir,
    env: {
      ...process.env,
      UV_PROJECT_ENVIRONMENT: join(sidecarDir, ".venv"),
      UV_CACHE_DIR: join(sidecarDir, ".uv-cache"),
    },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
