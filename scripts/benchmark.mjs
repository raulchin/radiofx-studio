import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execute, main, options } from "./tooling.mjs";

main(() => {
  const args = process.argv.slice(2);
  const index = args.indexOf("--report");
  let report;
  if (index !== -1) {
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error("--report requiere una ruta de archivo nuevo.");
    report = resolve(value);
    args.splice(index, 2);
  }
  const settings = options(args);
  if (report) {
    realpathSync(dirname(report));
    try {
      lstatSync(report);
      throw new Error("El informe ya existe; no se sobrescribira.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  execute(
    [
      {
        command: "cargo",
        args: [
          "test",
          "--release",
          "--locked",
          ...(settings.online ? [] : ["--offline"]),
          "--manifest-path",
          "src-tauri/Cargo.toml",
          "offline_audio_benchmark",
          "--",
          "--ignored",
          "--nocapture",
          "--test-threads=1",
        ],
      },
    ],
    settings,
    report ? { RADIOFX_BENCH_REPORT: report } : { RADIOFX_BENCH_REPORT: "" },
  );
  if (report && !settings.dryRun) {
    if (!lstatSync(report).isFile())
      throw new Error("El benchmark no ha creado un informe regular.");
    JSON.parse(readFileSync(report, "utf8"));
  }
});
