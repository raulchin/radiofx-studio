import { execute, main, npmCommand, options } from "./tooling.mjs";

main(() => {
  const settings = options(process.argv.slice(2));
  const locked = [
    "--locked",
    ...(settings.online ? [] : ["--offline"]),
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ];
  execute(
    [
      npmCommand(["run", "check"]),
      {
        command: "cargo",
        args: [
          "fmt",
          "--manifest-path",
          "src-tauri/Cargo.toml",
          "--all",
          "--",
          "--check",
        ],
      },
      {
        command: "cargo",
        args: ["clippy", ...locked, "--all-targets", "--", "-D", "warnings"],
      },
      { command: "cargo", args: ["test", ...locked] },
    ],
    settings,
  );
});
