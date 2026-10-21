import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { main, manifest, root } from "./tooling.mjs";
import { validateRelease } from "./release-policy.mjs";

/**
 * Calcula SHA-256 con memoria acotada, sin cargar el instalador completo.
 * @param {string} path Archivo regular a leer.
 * @returns {string} Hash hexadecimal.
 */
function sha256(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/**
 * Enumera archivos regulares ordenados; nunca sigue enlaces simbolicos.
 * @param {string} directory Directorio de confianza elegido por el desarrollador.
 * @returns {string[]} Rutas absolutas.
 * @throws {Error} Ante enlaces o entradas especiales.
 */
function files(directory) {
  if (!lstatSync(directory).isDirectory())
    throw new Error(`No es un directorio regular: ${directory}`);
  const result = [];
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink())
      throw new Error(`No se admiten enlaces: ${path}`);
    if (entry.isDirectory()) result.push(...files(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`No es un archivo regular: ${path}`);
  }
  return result;
}

/**
 * Normaliza las rutas del manifiesto entre plataformas.
 * @param {string} base Directorio base.
 * @param {string} path Ruta absoluta.
 * @returns {string} Ruta relativa con barras simples.
 */
function portable(base, path) {
  return relative(base, path).split(sep).join("/");
}

main(() => {
  const args = process.argv.slice(2);
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--directory", "--output"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      values.has(args[i])
    ) {
      throw new Error(
        "Uso: npm run release:artifacts -- [--directory <bundle>] [--output <archivo nuevo>]",
      );
    }
    values.set(args[i], args[i + 1]);
  }
  const directory = resolve(
    values.get("--directory") ??
      resolve(root, "src-tauri/target/release/bundle"),
  );
  const output = resolve(
    values.get("--output") ??
      resolve(root, "src-tauri/target/release/artifacts.json"),
  );
  const config = JSON.parse(
    readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const readiness = validateRelease();
  const packages = files(directory).filter((path) =>
    [".deb", ".rpm", ".appimage", ".msi", ".exe", ".dmg"].includes(
      extname(path).toLowerCase(),
    ),
  );
  if (packages.length === 0)
    throw new Error(
      "No hay instaladores reconocidos; un directorio .app no equivale a un DMG.",
    );
  const inventory = [];
  const inputs = [
    "src",
    "public",
    "tests",
    "scripts",
    ".github",
    "src-tauri/src",
    "src-tauri/migrations",
    "src-tauri/capabilities",
    "src-tauri/permissions",
    "src-tauri/icons",
  ];
  for (const name of inputs) {
    const path = resolve(root, name);
    try {
      inventory.push(...files(path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const base of [root, resolve(root, "src-tauri")]) {
    for (const name of readdirSync(base).sort()) {
      const path = resolve(base, name);
      if (
        lstatSync(path).isFile() &&
        /\.(json|toml|lock|rs|ts|js|html)$/.test(name)
      )
        inventory.push(path);
    }
  }
  const sources = [...new Set(inventory)]
    .sort()
    .map((path) => ({ path: portable(root, path), sha256: sha256(path) }));
  const result = {
    schemaVersion: 1,
    product: config.productName,
    identifier: config.identifier,
    version: manifest.version,
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
    },
    distributionStatus: "unsigned-test-only-not-approved-for-publication",
    readiness,
    limitations: [
      "SHA-256 comprueba integridad, no firma ni autenticidad.",
      "La instantanea de fuentes se toma al crear el manifiesto, no acredita el origen ni la frescura de los binarios.",
      "Licencia, titular, firma/notarizacion y aceptacion manual siguen pendientes.",
    ],
    sourceSnapshot: {
      sha256: createHash("sha256")
        .update(JSON.stringify(sources))
        .digest("hex"),
      files: sources,
    },
    artifacts: packages.map((path) => ({
      path: portable(directory, path),
      bytes: lstatSync(path).size,
      sha256: sha256(path),
    })),
  };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Manifiesto de integridad creado sin sobrescritura: ${output}`);
});
