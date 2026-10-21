/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary: string[] = [];

/**
 * Sustituye la ruta npm sin duplicar claves equivalentes en el entorno de Windows.
 * @param path Ruta de la CLI JavaScript o wrapper que se quiere probar.
 * @param base Variables iniciales, incluidas variantes de mayúsculas heredadas del runner.
 * @returns Entorno con una única definición de npm_execpath.
 */
function npmEnvironment(path: string, base: NodeJS.ProcessEnv = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(base).filter(
        ([key]) => key.toLowerCase() !== "npm_execpath",
      ),
    ),
    npm_execpath: path,
  };
}

/**
 * Ejecuta solo la CLI de herramientas, nunca un build en estas pruebas.
 * @param script Nombre del script del repositorio.
 * @param args Opciones separadas del proceso.
 * @param cwd Directorio de llamada, para comprobar independencia del cwd.
 * @param env Entorno controlado del proceso hijo.
 * @returns Resultado capturado de Node.
 */
function cli(script: string, args: string[], cwd = root, env = process.env) {
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", script), ...args],
    {
      cwd,
      encoding: "utf8",
      env,
      shell: false,
    },
  );
}

/**
 * Crea fixtures aislados y registra exclusivamente su propia limpieza.
 * @returns Directorio temporal de la prueba.
 */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "radiofx-release-tooling-"));
  temporary.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("release command plans", () => {
  /** Las claves duplicadas por mayúsculas no deben ocultar el valor inyectado en los tests Windows. */
  it("replaces inherited npm paths regardless of environment variable casing", () => {
    const env = npmEnvironment("chosen.cjs", {
      NPM_EXECPATH: "inherited.cjs",
      npm_execpath: "other.cjs",
      PATH: "unchanged",
    });
    expect(env).toEqual({ PATH: "unchanged", npm_execpath: "chosen.cjs" });
  });
  /** Evita que autocrlf cambie los fuentes en Windows sin normalizar archivos binarios. */
  it("keeps text checkouts in LF on Windows and leaves installer resources binary", () => {
    const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
    expect(attributes.split(/\r?\n/)).toContain("* text=auto eol=lf");
    for (const extension of [
      "png",
      "ico",
      "icns",
      "wav",
      "mp3",
      "ogg",
      "flac",
      "rfxbank",
    ]) {
      expect(attributes.split(/\r?\n/)).toContain(`*.${extension} -text`);
    }
    expect(
      JSON.parse(readFileSync(join(root, ".prettierrc.json"), "utf8"))
        .endOfLine,
    ).toBe("lf");
  });

  /** Impide duplicar el símbolo de Info.plist al compilar los handlers IPC con macOS. */
  it("shares one generated Tauri context between production and IPC tests", () => {
    const production = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
    const ipc = readFileSync(
      join(root, "src-tauri/src/commands/ipc_tests.rs"),
      "utf8",
    );
    expect(production.match(/tauri::generate_context!\(\)/g)).toHaveLength(1);
    expect(ipc).not.toContain("tauri::generate_context!");
    expect(ipc).toContain(".build(crate::app_context())");
  });

  it("runs frontend then strict locked offline Rust checks without ignored hardware tests", () => {
    const result = cli("check.mjs", ["--dry-run"], fixture());
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.cwd).toBe(root);
    expect(plan.environment.CARGO_NET_OFFLINE).toBe("true");
    expect(plan.commands).toHaveLength(4);
    expect(plan.commands[0].command).toBe(process.execPath);
    expect(plan.commands[0].args.slice(-2)).toEqual(["run", "check"]);
    expect(plan.commands[1].args).toEqual([
      "fmt",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all",
      "--",
      "--check",
    ]);
    expect(plan.commands[2].args).toEqual([
      "clippy",
      "--locked",
      "--offline",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ]);
    expect(plan.commands[3].args).toEqual([
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ]);
  });

  it("requires explicit online opt-in and preserves locked resolution", () => {
    const result = cli("check.mjs", ["--dry-run", "--online"]);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.environment.CARGO_NET_OFFLINE).toBe("false");
    expect(plan.commands[2].args).toContain("--locked");
    expect(plan.commands[2].args).not.toContain("--offline");
  });

  it.each([
    ["--unknown"],
    ["--online", "--online"],
    ["--online;touch", "sentinel"],
  ])("rejects unsupported options before executing commands: %j", (...args) => {
    const result = cli("check.mjs", args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Opciones permitidas");
    expect(result.stdout).toBe("");
  });

  it("selects only the named CPU benchmark with one test thread", () => {
    const result = cli("benchmark.mjs", ["--dry-run"]);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0].args).toEqual([
      "test",
      "--release",
      "--locked",
      "--offline",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "offline_audio_benchmark",
      "--",
      "--ignored",
      "--nocapture",
      "--test-threads=1",
    ]);
    expect(plan.environment.RADIOFX_BENCH_REPORT).toBe("");
  });

  it("passes npm CLI paths with shell syntax as a single Node argument", () => {
    const npmCli = join(fixture(), "npm cli ; $HOME.cjs");
    writeFileSync(npmCli, "throw new Error('This fixture must not run');\n");
    const result = cli(
      "check.mjs",
      ["--dry-run"],
      root,
      npmEnvironment(npmCli),
    );
    expect(result.status).toBe(0);
    const command = JSON.parse(result.stdout).commands[0];
    expect(command).toEqual({
      command: process.execPath,
      args: [npmCli, "run", "check"],
    });
  });

  it("rejects npm command wrappers instead of invoking a shell", () => {
    const wrapper = join(fixture(), "npm.cmd");
    writeFileSync(wrapper, "not executable\n");
    const result = cli(
      "check.mjs",
      ["--dry-run"],
      root,
      npmEnvironment(wrapper),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLI JavaScript");
    expect(result.stdout).toBe("");
  });

  it.each([
    ["--unknown"],
    ["--online", "--online"],
    ["--offline"],
    ["--report", "--online"],
    ["--online;touch", "sentinel"],
  ])(
    "rejects unsupported benchmark options before execution: %j",
    (...args) => {
      const result = cli("benchmark.mjs", args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    },
  );

  it("opts the benchmark into online mode only explicitly and keeps the lock", () => {
    const result = cli("benchmark.mjs", ["--dry-run", "--online"]);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.environment.CARGO_NET_OFFLINE).toBe("false");
    expect(plan.commands[0].args).toContain("--locked");
    expect(plan.commands[0].args).not.toContain("--offline");
  });

  it("passes report paths as environment data, not shell syntax", () => {
    const report = join(fixture(), "report ; $HOME.json");
    const result = cli("benchmark.mjs", ["--dry-run", "--report", report]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).environment.RADIOFX_BENCH_REPORT).toBe(
      report,
    );
  });

  it("refuses an existing report and leaves it unchanged", () => {
    const report = join(fixture(), "report.json");
    writeFileSync(report, "original");
    const result = cli("benchmark.mjs", ["--dry-run", "--report", report]);
    expect(result.status).toBe(1);
    expect(readFileSync(report, "utf8")).toBe("original");
  });

  it("requires a report value and an existing parent", () => {
    expect(cli("benchmark.mjs", ["--report"]).status).toBe(1);
    expect(
      cli("benchmark.mjs", [
        "--dry-run",
        "--report",
        join(fixture(), "absent", "report.json"),
      ]).status,
    ).toBe(1);
  });

  it("guards host platform and limits unsigned packaging to approved targets", () => {
    const hosts: Partial<Record<NodeJS.Platform, string>> = {
      linux: "linux",
      win32: "windows",
      darwin: "macos",
    };
    const host = hosts[process.platform];
    expect(host).toBeDefined();
    const result = cli("bundle.mjs", [host ?? "unsupported", "--dry-run"]);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.commands[0].args).toContain("--no-sign");
    expect(plan.commands[0].args).toContain("--locked");
    expect(plan.commands[0].args).toContain("--offline");
    expect(
      cli("bundle.mjs", [host === "linux" ? "windows" : "linux", "--dry-run"])
        .status,
    ).toBe(1);
    expect(cli("bundle.mjs", ["other", "--dry-run"]).status).toBe(1);
  });
});

describe("artifact integrity manifests", () => {
  it("hashes nested installers, fingerprints source and never overwrites output", () => {
    const directory = fixture();
    mkdirSync(join(directory, "deb"));
    const bytes = Buffer.from("fixture, not a real installer");
    writeFileSync(join(directory, "deb", "radio fx.deb"), bytes);
    writeFileSync(join(directory, "ignored.txt"), "not a package");
    const output = join(directory, "manifest.json");
    const args = ["--directory", directory, "--output", output];
    const result = cli("artifacts.mjs", args);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const saved = readFileSync(output, "utf8");
    const manifest = JSON.parse(saved);
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.identifier).toBe("com.chinlabsgroup.radiofx-studio");
    expect(manifest.artifacts).toEqual([
      {
        path: "deb/radio fx.deb",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ]);
    expect(manifest.distributionStatus).toBe(
      "unsigned-test-only-not-approved-for-publication",
    );
    expect(manifest.sourceSnapshot.files).toContainEqual({
      path: "package-lock.json",
      sha256: createHash("sha256")
        .update(readFileSync(join(root, "package-lock.json")))
        .digest("hex"),
    });
    expect(cli("artifacts.mjs", args).status).toBe(1);
    expect(readFileSync(output, "utf8")).toBe(saved);
  });

  it("rejects an empty directory rather than reporting successful packaging", () => {
    const directory = fixture();
    const result = cli("artifacts.mjs", [
      "--directory",
      directory,
      "--output",
      join(directory, "manifest.json"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No hay instaladores");
  });

  it("rejects symlink inputs without following them", () => {
    const directory = fixture();
    const outside = fixture();
    writeFileSync(join(outside, "outside.deb"), "outside");
    symlinkSync(
      outside,
      join(directory, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = cli("artifacts.mjs", [
      "--directory",
      directory,
      "--output",
      join(directory, "manifest.json"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No se admiten enlaces");
    expect(readFileSync(join(outside, "outside.deb"), "utf8")).toBe("outside");
  });

  it.each([
    ["--output"],
    ["--directory", ".", "--directory", "."],
    ["--publish"],
  ])("rejects malformed manifest options: %j", (...args) => {
    expect(cli("artifacts.mjs", args).status).toBe(1);
  });
});

describe("distribution configuration", () => {
  it("declares native Debian dependencies and the conservative Ubuntu 24.04 ABI baseline", () => {
    const linux = JSON.parse(
      readFileSync(join(root, "src-tauri/tauri.linux.conf.json"), "utf8"),
    );
    expect(linux.bundle.targets).toEqual(["deb"]);
    expect(linux.bundle.linux.deb.depends).toEqual(
      expect.arrayContaining([
        "libwebkit2gtk-4.1-0",
        "libgtk-3-0",
        "libasound2t64 | libasound2",
        "libc6 (>= 2.39)",
        "libgcc-s1",
        "libdbus-1-3",
      ]),
    );
    expect(linux.bundle.linux.deb.section).toBe("sound");
  });

  it("fails the release preflight when ALSA or the libc baseline is removed", () => {
    const sandbox = fixture();
    for (const name of [
      "scripts/tooling.mjs",
      "scripts/release-policy.mjs",
      "scripts/release-preflight.mjs",
      "package.json",
      "package-lock.json",
      "src-tauri/Cargo.toml",
      "src-tauri/build.rs",
      "src-tauri/tauri.conf.json",
      "src-tauri/tauri.linux.conf.json",
      "src-tauri/tauri.windows.conf.json",
      "src-tauri/tauri.macos.conf.json",
      "src-tauri/capabilities/default.json",
    ]) {
      const destination = join(sandbox, name);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(root, name)));
    }
    for (const missing of ["libasound2t64 | libasound2", "libc6 (>= 2.39)"]) {
      const linux = JSON.parse(
        readFileSync(join(root, "src-tauri/tauri.linux.conf.json"), "utf8"),
      );
      linux.bundle.linux.deb.depends = linux.bundle.linux.deb.depends.filter(
        (dependency: string) => dependency !== missing,
      );
      writeFileSync(
        join(sandbox, "src-tauri/tauri.linux.conf.json"),
        JSON.stringify(linux),
      );
      const result = spawnSync(
        process.execPath,
        [join(sandbox, "scripts/release-preflight.mjs")],
        { cwd: sandbox, encoding: "utf8", shell: false },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("El paquete Debian debe declarar");
    }
  });

  it("audits the real command registry without approving publication", () => {
    const result = cli("release-preflight.mjs", []);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "0.1.0",
      commands: 25,
      publicationAllowed: false,
    });
    expect(JSON.parse(result.stdout).blockers).toHaveLength(4);
    expect(cli("release-preflight.mjs", ["--publish"]).status).toBe(1);
  });

  it("keeps the CI Node pin aligned with nvm and existing package engines", () => {
    const toolchain = JSON.parse(
      readFileSync(join(root, "scripts/toolchain.json"), "utf8"),
    );
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(readFileSync(join(root, ".nvmrc"), "utf8").trim()).toBe(
      toolchain.node,
    );
    expect(toolchain).toEqual({ node: "22.23.3", rust: "1.99.1" });
    expect(pkg.engines.node).toBe("^22.13.0 || >=24.0.0");
  });

  it("provides generated desktop icon containers and an original SVG source", () => {
    const iconRoot = join(root, "src-tauri/icons");
    const png = readFileSync(join(iconRoot, "128x128.png"));
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
    expect(
      readFileSync(join(iconRoot, "icon.icns"))
        .subarray(0, 4)
        .toString("ascii"),
    ).toBe("icns");
    expect(readFileSync(join(iconRoot, "icon.ico")).subarray(0, 4)).toEqual(
      Buffer.from([0, 0, 1, 0]),
    );
    expect(readFileSync(join(iconRoot, "radiofx.svg"), "utf8")).not.toMatch(
      /<text|<image|href=/,
    );
  });

  it("keeps the identity and CSP intact without granting microphone access", () => {
    const base = JSON.parse(
      readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(base.identifier).toBe("com.chinlabsgroup.radiofx-studio");
    expect(base.version).toBe("0.1.0");
    expect(base.app.security.csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(base.bundle).not.toHaveProperty("publisher");
    expect(base.bundle).not.toHaveProperty("license");
    const macos = readFileSync(
      join(root, "src-tauri/tauri.macos.conf.json"),
      "utf8",
    );
    expect(macos).not.toMatch(
      /microphone|NSMicrophoneUsageDescription|audio-input/i,
    );
  });

  it("embeds offline WebView2 and disallows silent Windows downgrades", () => {
    const windows = JSON.parse(
      readFileSync(join(root, "src-tauri/tauri.windows.conf.json"), "utf8"),
    );
    expect(windows.bundle.targets).toEqual(["nsis"]);
    expect(windows.bundle.windows.webviewInstallMode.type).toBe(
      "offlineInstaller",
    );
    expect(windows.bundle.windows.allowDowngrades).toBe(false);
  });
});
