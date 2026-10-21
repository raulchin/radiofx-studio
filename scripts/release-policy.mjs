import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { manifest, root } from "./tooling.mjs";

/**
 * Comprueba versiones, identidad, dependencias Debian y permisos de esta fase.
 * No reemplaza las pruebas IPC ni acredita licencia, firma o aceptacion manual.
 * @returns {{version: string, identifier: string, commands: number, publicationAllowed: false, blockers: string[]}} Estado de preparacion.
 * @throws {Error} Ante divergencias de version, identidad, CSP, ACL o dependencias Debian.
 */
export function validateRelease() {
  const config = JSON.parse(
    readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(resolve(root, "package-lock.json"), "utf8"),
  );
  const cargo = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8")
    .split(/^\[/m)
    .find((section) => section.startsWith("package]"));
  const cargoVersion = cargo?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (
    ![
      config.version,
      lock.version,
      lock.packages?.[""]?.version,
      cargoVersion,
    ].every((version) => version === manifest.version)
  ) {
    throw new Error("Las versiones de npm, lock, Cargo y Tauri no coinciden.");
  }
  if (
    config.identifier !== "com.chinlabsgroup.radiofx-studio" ||
    config.version !== "0.1.0"
  ) {
    throw new Error(
      "La identidad/version requiere revision explicita antes de modificar rutas de datos o distribuir.",
    );
  }
  const csp =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' asset: http://asset.localhost; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; frame-src 'none'";
  if (
    config.app?.security?.csp !== csp ||
    config.app.security.capabilities !== undefined
  ) {
    throw new Error(
      "La CSP o la seleccion de capabilities ha cambiado; revisar la politica de produccion.",
    );
  }
  const capabilities = resolve(root, "src-tauri/capabilities");
  const entries = readdirSync(capabilities).filter((name) =>
    /\.(json|json5|toml)$/.test(name),
  );
  if (entries.length !== 1 || entries[0] !== "default.json")
    throw new Error("Se esperaba solo la capability default.json.");
  const capability = JSON.parse(
    readFileSync(resolve(capabilities, "default.json"), "utf8"),
  );
  const build = readFileSync(resolve(root, "src-tauri/build.rs"), "utf8");
  const registry = build.match(/\.commands\(&\[([\s\S]*?)\]\)/)?.[1];
  if (!registry || registry.replace(/"[a-z_]+"|[\s,]/g, "") !== "")
    throw new Error("Registro de comandos no reconocido; revisar build.rs.");
  const commands = [...registry.matchAll(/"([a-z_]+)"/g)].map(
    (match) => match[1],
  );
  const expected = [
    ...commands.map((command) => `allow-${command.replaceAll("_", "-")}`),
    "core:event:allow-listen",
    "core:event:allow-unlisten",
  ].sort();
  if (
    commands.length !== 25 ||
    new Set(commands).size !== 25 ||
    JSON.stringify(capability.windows) !== '["main"]' ||
    Object.keys(capability).some(
      (key) =>
        ![
          "$schema",
          "identifier",
          "description",
          "windows",
          "permissions",
        ].includes(key),
    ) ||
    !Array.isArray(capability.permissions) ||
    JSON.stringify([...capability.permissions].sort()) !==
      JSON.stringify(expected)
  ) {
    throw new Error(
      "La ACL debe limitarse a main, 25 comandos registrados y escuchar/liberar eventos.",
    );
  }
  for (const platform of ["linux", "windows", "macos"]) {
    const override = JSON.parse(
      readFileSync(
        resolve(root, `src-tauri/tauri.${platform}.conf.json`),
        "utf8",
      ),
    );
    if (
      Object.keys(override).some((key) => !["$schema", "bundle"].includes(key))
    )
      throw new Error(
        "Los overrides de plataforma solo deben configurar el bundle.",
      );
    if (platform === "linux") {
      const depends = override.bundle?.linux?.deb?.depends;
      // Baseline conservador del build Ubuntu 24.04; no promete soporte de glibc anteriores.
      const required = [
        "libwebkit2gtk-4.1-0",
        "libgtk-3-0",
        "libasound2t64 | libasound2",
        "libc6 (>= 2.39)",
        "libgcc-s1",
        "libdbus-1-3",
      ];
      if (
        !Array.isArray(depends) ||
        required.some((dependency) => !depends.includes(dependency))
      ) {
        throw new Error(
          "El paquete Debian debe declarar GTK/WebKit, ALSA, glibc >= 2.39, libgcc y D-Bus para el baseline Ubuntu 24.04.",
        );
      }
    }
  }
  return {
    version: manifest.version,
    identifier: config.identifier,
    commands: commands.length,
    publicationAllowed: false,
    blockers: [
      "Licencia y titular pendientes de confirmacion.",
      "Identidad visual provisional; identificador existente conservado.",
      "Sin firma ni notarizacion; solo paquetes de prueba.",
      "Aceptacion desktop, hardware y plataformas pendiente.",
    ],
  };
}
