# Paquetes y publicación

## Estado de distribución

**PUBLICACIÓN BLOQUEADA. Solo existe un DEB Linux local de prueba sin firma, no aprobado para publicación.** Generar un paquete o superar `release:preflight` no cierra Fase 6. No hay licencia de producto ni titular/publisher confirmados; no se inventan esos datos ni se atribuyen derechos a partir del identificador.

Se mantienen `0.1.0` en npm/lock/Cargo/Tauri y `com.chinlabsgroup.radiofx-studio` para no relocalizar datos. El identificador existente no prueba titularidad ni registro. El icono de plantilla se sustituyó por `src-tauri/icons/radiofx.svg`, original provisional, y derivados PNG/ICO/ICNS generados con Tauri CLI; aprobación visual y derechos siguen pendientes.

## Artefacto vigente con la corrección

El DEB se reconstruyó con el reinicio del mismo efecto desde cero: `src-tauri/target/release/bundle/deb/RadioFX Studio_0.1.0_amd64.deb`, SHA-256 `872e775ddc5c42ebfb618c2d7b2bb74a21229c203e0daaf11407c1e5ab25a78c`. El manifiesto vigente es `src-tauri/target/release/artifacts-restart.json`, generado con `npm run release:artifacts -- --output src-tauri/target/release/artifacts-restart.json` sin sobrescribir `artifacts.json`. Para contrastar el paquete actual debe usarse este nuevo manifiesto, no el anterior. La tabla e inspecciones posteriores conservan el registro histórico del DEB previo y su hash, no describen los bytes reconstruidos.

Validación final con Node 22.23.3 y Rust 1.99.1: `npm run check:all` superado, 266 pruebas frontend en 16 archivos, 122 Rust correctas y 2 ignoradas, rustfmt y Clippy all-targets sin advertencias; `npm run bundle:linux` superado, con release Linux y DEB reconstruidos. Registro/ACL: 25 comandos, 17 de audio y 8 de biblioteca/paquetes, incluido `restart_effect`. Detalle en [VERIFICATION.md](VERIFICATION.md#corrección-reinicio-al-repetir-un-efecto).

El paquete conserva `0.1.0`, sin firma y solo de prueba; no se instaló. Generarlo no actualiza automáticamente una instalación anterior: hay que usar la aplicación actualizada para incorporar la corrección. No se realizaron pruebas GUI/audio/hardware para esta corrección ni se repitieron las inspecciones históricas siguientes. No se abre otra fase ni se autoriza publicación.

## Preparación y comandos

Usar Node/Rust compatibles y prerrequisitos Tauri en el host correspondiente. Referencia: Node 22.23.3 y Rust 1.99.1 en `scripts/toolchain.json`; preparación de dependencias puede necesitar red. Los scripts no instalan herramientas globales. Instrucciones locales y resultados en [PHASE_6.md](PHASE_6.md).

```bash
npm run release:preflight
npm run check:all
npm run bundle:linux -- --dry-run
npm run bundle:linux
npm run release:artifacts
```

El preflight verifica versiones, identidad conservada, CSP/ACL y dependencias Debian. Su resultado incluye `publicationAllowed: false` y bloqueos aunque termine con código 0. No sustituye auditoría legal, de seguridad o aceptación manual.

Los bundles requieren el host nativo y generan pruebas con `--no-sign`; rechazan otra plataforma. `--dry-run` muestra el plan, no produce un paquete. Cargo es locked/offline por defecto. En Windows/macOS el build real exige consentimiento `--online` porque NSIS/WebView2 o herramientas DMG pueden necesitar descargas ajenas a Cargo:

```bash
npm run bundle:windows -- --online
npm run bundle:macos -- --online
```

Son instrucciones preparadas, **no ejecuciones acreditadas**. El override Windows configura NSIS, `allowDowngrades: false` y WebView2 `offlineInstaller` silencioso, no un bootstrapper que deba descargar durante la instalación. Su inclusión/instalación offline debe comprobarse en Windows limpio. macOS configura app y DMG, sin mínimos de sistema ni compatibilidad certificados. Linux configura solo DEB; no se generaron AppImage ni RPM.

## DEB anterior: registro histórico

| Campo                                      | Evidencia local                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Ruta                                       | `src-tauri/target/release/bundle/deb/RadioFX Studio_0.1.0_amd64.deb`                    |
| Tamaño                                     | 3833166 bytes                                                                           |
| SHA-256                                    | `2f49f6920e0aff5f78d14561ed408767c7d426686dd436723f3b2226aba02ea3`                      |
| Package / Version / Architecture / Section | `radio-fx-studio` / `0.1.0` / `amd64` / `sound`                                         |
| Maintainer generado                        | `chinlabsgroup`, derivado por las herramientas; no confirma titular ni publisher legal. |
| Estado                                     | Sin firma, prueba local, no instalado, no publicable.                                   |

`npm run bundle:linux` superó frontend y Tauri release con LTO: `tauri build --ci --no-sign --bundles deb -- --locked --offline`. La inspección con `dpkg-deb` y extracción sin root a `/tmp/opencode/radiofx-deb-inspection` comprobó los metadatos y `desktop-file-validate` pasó. `ldd` no mostró dependencias faltantes en este host. `readelf` mostró ELF tipo DYN/PIE, RELRO y stack RW sin ejecución; no es una auditoría completa de hardening ni vulnerabilidades.

Dependencias declaradas: `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libasound2t64 | libasound2`, `libc6 (>= 2.39)`, `libgcc-s1` y `libdbus-1-3`; Tauri puede añadir entradas GTK/WebKit. La revisión corrigió la ausencia de ALSA en metadatos y añadió regresiones/preflight para impedir su omisión. glibc >= 2.39 es un baseline conservador del entorno Ubuntu 24.04/Mint 22.2, **no compatibilidad con distribuciones anteriores ni certificación universal de Linux**.

No se instaló con root ni se validaron integración del menú en una instalación real, actualización, desinstalación o limpieza de perfiles. El arranque del binario release descrito en PHASE_6 no sustituye probar el paquete instalado. Recomendada VM/perfil de pruebas limpio, con copia de seguridad y todas las instancias cerradas.

## Integridad y trazabilidad

En la entrega anterior, `npm run release:artifacts` creó `src-tauri/target/release/artifacts.json`: producto, host, estado de bloqueo, tamaños/SHA-256 de instaladores e inventario/fingerprint de fuentes. Es un manifiesto histórico; el vigente tras la corrección es `src-tauri/target/release/artifacts-restart.json`. El archivo se crea de forma exclusiva; repetir sobre el mismo destino falla intencionadamente. Para una nueva inspección sin reemplazarlo:

```bash
npm run release:artifacts -- --output /tmp/opencode/radiofx-artifacts-new.json
sha256sum "src-tauri/target/release/bundle/deb/RadioFX Studio_0.1.0_amd64.deb"
dpkg-deb --field "src-tauri/target/release/bundle/deb/RadioFX Studio_0.1.0_amd64.deb" Package Version Architecture Section Depends
```

El directorio de salida debe existir. SHA-256 permite contrastar bytes, **no firma ni acredita autenticidad**. El inventario se calcula al crear el manifiesto después del build, no garantiza que ese binario proceda de esas fuentes ni que esté actualizado; tampoco demuestra reproducibilidad bit a bit. Documentación no forma parte de ese inventario de código. Los binarios, paquetes y manifiesto de target son artefactos locales ignorados, no se incorporan a la documentación ni al control de versiones como entrega pública.

## CI preparada

`quality.yml` contempla push/PR/ejecución manual en Ubuntu 24.04, Windows y macOS. `distribution.yml` solo se dispara manualmente: calidad, paquetes sin firma, manifiesto y benchmark Linux opcional, con retención de artefactos de 14 días. Ambos leen versiones explícitas del proyecto, usan permisos `contents: read` y preparan dependencias con red explícita; los paquetes de sistema mediante apt son preparación del runner, no instalación local realizada en esta sesión.

Los workflows están preparados, **no ejecutados remotamente ni equivalentes a validación de las otras plataformas**. No contienen publicación de releases, autoactualización, secretos de firma ni notarización. Las actions usan referencias de versión mayor, no hashes completos: queda como riesgo de cadena de suministro a revisar antes de publicación. No se afirma una auditoría actualizada de vulnerabilidades con base de datos offline ni ausencia de vulnerabilidades por estos checks.

## Bloqueos del titular

| Decisión o evidencia requerida                                              | Estado                                   |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| Licencia del producto, titular y avisos/derechos de terceros                | Pendiente; no hay LICENSE confirmada.    |
| Publisher/maintainer legal, contacto y aprobación de identidad/icono        | Pendiente; no deducir del identificador. |
| Política de distribución y confianza/firma de Linux y Windows               | Pendiente; paquete actual sin firma.     |
| Certificados, firma y notarización macOS, verificación en equipo limpio     | Pendiente.                               |
| Builds y aceptación Windows/macOS nativos                                   | Pendiente.                               |
| Instalación/actualización/desinstalación y compatibilidad por versión de SO | Pendiente.                               |
| Aceptación desktop, accesibilidad y mediciones físicas                      | Pendiente según HARDWARE_TESTS.          |

Antes de actualizar datos, cerrar todas las instancias y respaldar el perfil completo, incluidos SQLite y audio gestionado. Ensayar migraciones con copia aislada. Una versión futura de SQLite se rechaza sin reset; no prometer downgrade de datos ni borrar el perfil para resolver un error. Desinstalar no autoriza eliminar biblioteca del usuario. La publicación requiere decisión explícita del titular tras resolver y registrar estos bloqueos; no se ejecuta automáticamente al terminar la documentación.
