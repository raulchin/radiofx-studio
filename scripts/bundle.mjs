import { execute, main, npmCommand, options } from "./tooling.mjs";
import { validateRelease } from "./release-policy.mjs";

main(() => {
  const [platform, ...args] = process.argv.slice(2);
  const hosts = { linux: "linux", windows: "win32", macos: "darwin" };
  const targets = { linux: "deb", windows: "nsis", macos: "app,dmg" };
  if (!Object.hasOwn(hosts, platform) || hosts[platform] !== process.platform) {
    throw new Error(
      "El empaquetado requiere el sistema anfitrion correspondiente: linux, windows o macos.",
    );
  }
  const settings = options(args);
  validateRelease();
  if (!settings.dryRun && !settings.online && process.platform !== "linux") {
    throw new Error(
      "NSIS/WebView2 y DMG pueden necesitar descargas ajenas a Cargo. Se requiere --online como consentimiento explicito; no se ha iniciado el build.",
    );
  }
  if (!settings.dryRun)
    console.warn(
      "Paquete de prueba SIN FIRMA. Licencia, titular, identidad final y aceptacion manual pendientes; no publicar.",
    );
  execute(
    [
      npmCommand([
        "run",
        "tauri",
        "--",
        "build",
        "--ci",
        "--no-sign",
        "--bundles",
        targets[platform],
        "--",
        "--locked",
        ...(settings.online ? [] : ["--offline"]),
      ]),
    ],
    settings,
  );
});
