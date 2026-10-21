import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
export const manifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);

/**
 * Ejecuta un proceso sin shell y propaga sus fallos.
 * @param {string} command Ejecutable de confianza del entorno de desarrollo.
 * @param {string[]} args Argumentos separados, nunca interpretados por un shell.
 * @param {NodeJS.ProcessEnv} env Entorno del proceso hijo.
 * @returns {void}
 * @throws {Error} Si el directorio o el proceso no son utilizables.
 */
export function run(command, args, env = process.env) {
  if (!statSync(root).isDirectory())
    throw new Error("La raiz del proyecto no es un directorio.");
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Fallo de ${command}: ${result.signal ?? result.status}`);
}

/**
 * Resuelve npm como programa JavaScript, tambien en Windows, sin ejecutar .cmd.
 * @param {string[]} args Argumentos de npm.
 * @returns {{command: string, args: string[]}} Invocacion sin shell.
 * @throws {Error} Si no se inicio mediante npm o su CLI no existe.
 */
export function npmCommand(args) {
  const cli = process.env.npm_execpath;
  if (
    !cli ||
    !isAbsolute(cli) ||
    !statSync(cli).isFile() ||
    !/\.(c?js|mjs)$/.test(cli)
  ) {
    throw new Error(
      "Ejecuta esta herramienta mediante npm run; npm_execpath debe apuntar a su CLI JavaScript.",
    );
  }
  return { command: process.execPath, args: [cli, ...args] };
}

/**
 * Valida Node contra la politica declarada y muestra las versiones disponibles.
 * @returns {void}
 * @throws {Error} Ante Node incompatible o herramientas ausentes.
 */
export function preflight() {
  const policy = "^22.13.0 || >=24.0.0";
  if (manifest.engines?.node !== policy) {
    throw new Error(
      "La politica engines.node ha cambiado; actualiza el preflight junto con ella.",
    );
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 22 && minor >= 13) || major >= 24)) {
    throw new Error(
      `Node ${process.versions.node} no cumple ${policy}. No se instalaran herramientas.`,
    );
  }
  console.log(
    `Node ${process.versions.node}; ${process.platform}/${process.arch}`,
  );
  const npm = npmCommand(["--version"]);
  run(npm.command, npm.args);
  run("rustc", ["--version"]);
  run("cargo", ["--version"]);
  run("rustfmt", ["--version"]);
  run("cargo", ["clippy", "--version"]);
}

/**
 * Interpreta exclusivamente las opciones comunes conocidas.
 * @param {string[]} args Opciones del usuario.
 * @returns {{online: boolean, dryRun: boolean}} Politica de ejecucion.
 * @throws {Error} Si hay opciones desconocidas o duplicadas.
 */
export function options(args) {
  if (
    new Set(args).size !== args.length ||
    args.some((arg) => !["--online", "--dry-run"].includes(arg))
  ) {
    throw new Error(
      "Opciones permitidas: --online y --dry-run (sin duplicados).",
    );
  }
  return {
    online: args.includes("--online"),
    dryRun: args.includes("--dry-run"),
  };
}

/**
 * Ejecuta un plan o lo muestra sin lanzar herramientas ni tocar archivos.
 * @param {{command: string, args: string[]}[]} commands Procesos previstos.
 * @param {{online: boolean, dryRun: boolean}} settings Politica de red y simulacion.
 * @param {NodeJS.ProcessEnv} extraEnv Variables especificas de la herramienta.
 * @returns {void}
 */
export function execute(commands, settings, extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
    CARGO_NET_OFFLINE: settings.online ? "false" : "true",
  };
  if (settings.dryRun) {
    console.log(
      JSON.stringify(
        {
          cwd: root,
          commands,
          environment: {
            ...extraEnv,
            CARGO_NET_OFFLINE: env.CARGO_NET_OFFLINE,
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  preflight();
  for (const command of commands) run(command.command, command.args, env);
}

/**
 * Presenta errores de CLI sin esconder un codigo de salida fallido.
 * @param {() => void} action Entrada de la herramienta.
 * @returns {void}
 */
export function main(action) {
  try {
    action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
