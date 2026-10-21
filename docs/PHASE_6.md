# Fase 6: validación y distribución

## Estado

Fase autorizada, implementada en sus herramientas de calidad, benchmark, CI y configuración de paquetes, con validación local Linux parcial. **No está cerrada ni lista para publicar.** Los bloqueos legales/de identidad, firmas, plataformas y aceptación desktop/hardware se detallan en [RELEASE.md](RELEASE.md) y [HARDWARE_TESTS.md](HARDWARE_TESTS.md).

Esta actualización solo modifica documentación y conserva el JSON de benchmark. Los scripts, pruebas, configuraciones e iconos descritos ya estaban implementados. PHASE_2/3/4/5 y los registros anteriores de VERIFICATION se conservan como históricos; sus puertas no revocan la autorización actual.

## Herramientas y alcance

| Ubicación                                                                    | Función                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scripts/check.mjs`, `tooling.mjs`                                           | Cadena frontend y Rust, preflight de herramientas, offline por defecto y simulación de comandos.                   |
| `scripts/toolchain.json`, `.nvmrc`                                           | Referencia Node 22.23.3; JSON también fija Rust 1.99.1 para CI.                                                    |
| `scripts/benchmark.mjs`, `src-tauri/src/infrastructure/audio/performance.rs` | Benchmark release opt-in del mezclador real en memoria; helpers y estrés cubiertos por tests normales.             |
| `scripts/release-preflight.mjs`, `release-policy.mjs`                        | Coherencia de versiones, identidad, CSP, ACL y dependencias DEB; publicación siempre bloqueada.                    |
| `scripts/bundle.mjs`, `artifacts.mjs`                                        | Paquetes de prueba sin firma y manifiesto exclusivo SHA-256.                                                       |
| `.github/workflows/quality.yml`, `distribution.yml`                          | Calidad y generación manual de paquetes en hosts Linux/Windows/macOS; preparados, sin ejecución remota acreditada. |
| `src-tauri/tauri.*.conf.json`, `icons/radiofx.svg` y derivados               | Targets por plataforma e icono propio provisional; identidad legal/final sin confirmar.                            |
| `tests/release-tooling.test.ts`                                              | 31 regresiones de herramientas/metadatos incluidas en el total frontend.                                           |

No hay cambios de arquitectura que requieran un ADR nuevo: una salida por motor, autoridad Rust, datos locales y permisos mínimos siguen vigentes. No se incorporan servicios de red runtime ni se promete compatibilidad multiplataforma a partir de Linux.

## Entorno y comandos

Entorno registrado: Linux Mint 22.2 x86_64, kernel `6.14.0-35-generic`, glibc 2.39, Intel Core Ultra 7 155H con 22 procesadores lógicos. Node 22.23.3 cacheado, npm 9.2.0, Rust/Cargo 1.99.1 y Tauri CLI 2.12.3. Rust estable ya estaba instalado en `$HOME/.cargo/bin`; no se instaló globalmente en esta sesión. Node 18 habitual es incompatible.

En esta máquina, anteponer por comando las herramientas existentes, sin modificar el entorno global:

```bash
env PATH="$HOME/.cargo/bin:$HOME/.npm/_npx/d0a7a686d16af82b/node_modules/node/bin:$PATH" npm run check:all
```

La ruta cacheada es local, no requisito portable. Con versiones compatibles en PATH:

```bash
npm run check:all
npm run check:all -- --dry-run
npm run release:preflight
npm run bench:audio -- --report /tmp/opencode/radiofx-benchmark-new.json
npm run bench:audio
```

El directorio del informe debe existir y el archivo ser nuevo; no se sobrescribe. Sin `--report` se imprime JSON sin crear archivo. `check:all` ejecuta `npm run check`, rustfmt, Clippy all-targets con advertencias como error y `cargo test`; no incluye benchmark, hardware ni bundle. Cargo usa `--locked --offline` por defecto. `--online` permite red de preparación explícitamente, sin sustituir los lockfiles; no instala Node/Rust localmente. `--dry-run` muestra el plan sin ejecutar herramientas de validación.

## Resultados registrados

| Comprobación                         | Evidencia y límite                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadena principal inicial `check:all` | Superada con 254 frontend antes de las diez regresiones finales de metadatos.                                                                      |
| Suite frontend actual                | Revisión independiente: 264 pruebas en 16 archivos superadas; total acumulado, no sumable a las fases anteriores.                                  |
| Comprobaciones normales posteriores  | Tipos, ESLint, Prettier y checks normales superados; no presentar la cadena inicial de 254 como si ya contuviera 264.                              |
| Rust normal                          | 116 correctas, 2 ignoradas: apertura hardware y benchmark opt-in. rustfmt y Clippy `--all-targets --locked --offline -- -D warnings` superados.    |
| Benchmark release offline            | Superado con informe y también sin informe tras corregir el tratamiento del entorno vacío.                                                         |
| `npm run bundle:linux`               | Build frontend y Tauri release con LTO, `--ci --no-sign --bundles deb -- --locked --offline`, superados.                                           |
| Inspección DEB sin root              | Metadatos, extracción temporal, `desktop-file-validate`, dependencias con `ldd` e inspección ELF superados dentro del alcance descrito en RELEASE. |
| Arranque/reapertura desktop          | Proceso release, ventana e inicialización/reapertura SQLite en perfil XDG aislado comprobados; no E2E funcional.                                   |

Los intentos iniciales de estrés/compilación y un timeout de Cargo a 240 s no cuentan como éxito. Tras corregir el caso de paradas aún activas y repetir con margen de 600 s, el benchmark pasó. No se publican tiempos de debug como rendimiento release.

## Benchmark offline

Evidencia: [JSON completo](validation/offline-benchmark-linux-x86_64.json), transcrito del informe `/tmp/opencode/radiofx-offline-benchmark-final.json` sin cambiar sus datos. Se conserva `timestampUnixMilliseconds: 1792544451910` del origen, sin inventar una fecha de medición. El contexto CPU/herramientas anterior complementa el JSON, que no lo recoge todo automáticamente.

Implementación bajo `cfg(test)` y prueba ignorada opt-in. El runner exige `--release`, `--locked`, un hilo de test y, por defecto, `--offline`. Consume el render de `NativeDriver`, `Engine` y `AudioService` en memoria; no abre salida CPAL, GUI ni datos de usuario. Parámetros: 48000 Hz, 2 canales, bloques de 512 frames/1024 muestras, 100 bloques de calentamiento y 200 medidos por escenario. Percentiles por rango más cercano, sin interpolación. Los tiempos de render incluyen comprobaciones de finitud/picos; excluyen compilación y arranque del worker.

| Voces en loop | Render p50 (µs/bloque) | p95      | p99      | Pico absoluto observado |
| ------------- | ---------------------- | -------- | -------- | ----------------------- |
| 1             | 54.790                 | 68.788   | 75.245   | 0.062908                |
| 16            | 518.007                | 528.256  | 587.036  | 0.746763                |
| 64            | 2004.865               | 2080.521 | 2518.812 | 0.949609                |

Cada bloque representa `512 / 48000 = 10.6666667 ms` de audio, no esa duración de ejecución. Cada escenario mide 2.133333 s de PCM representado. `softwareRealtimeFactor` es la relación entre audio representado y tiempo de render medido: **no porcentaje de CPU, latencia audible ni garantía de tiempo real**.

| Medida separada                       | Muestras | p95 (µs) | Interpretación                                                         |
| ------------------------------------- | -------- | -------- | ---------------------------------------------------------------------- |
| ACK de play                           | 100      | 296.671  | Respuesta del servicio/worker offline, sin IPC WebView ni dispositivo. |
| ACK de STOP                           | 100      | 9953.546 | Confirmación del worker; no instante de silencio físico.               |
| Corte hasta consumir siguiente bloque | 100      | 10.151   | Activación de corte y render offline; ensayo distinto del ACK.         |
| Adaptación caliente mono a estéreo    | 200      | 0.189    | Reutilización de PCM preparado.                                        |

La adaptación en frío fue una única observación de 580.367 µs para 21600 frames mono a 43200 muestras estéreo; no es un percentil ni incluye decoder/arranque.

Estrés: un ciclo de calentamiento y 500 ciclos de 16 voces, 250 con final natural y 250 paradas aún activas tras 32 de 128 frames. Se comprueban voces vivas, referencias compartidas, silencio, pools/handles al volver a la línea base y cierre con voces, conversiones y fuentes a cero. Esto acredita esos recursos propios en el escenario, no ausencia universal de fugas. RSS observado al terminar calentamiento y al final: 17452 KiB en ambos casos; son dos observaciones del proceso completo, **no una prueba de RSS estable ni una aserción sobre el allocator**.

Los picos y maestro cero tienen comprobaciones numéricas. La protección `tanh` colorea la mezcla: no prueba calidad auditiva, clipping en hardware, USB ni p95 audible < 50 ms. Todo ello sigue pendiente en HARDWARE_TESTS.

## Arranque desktop aislado

Se lanzó el binario release bajo timeout, con `XDG_DATA_HOME`, `XDG_CONFIG_HOME` y `XDG_CACHE_HOME` dentro de `/tmp/opencode/radiofx-desktop-esdCMt/`. No se utilizó el perfil normal del usuario. `xwininfo -name` detectó ventana `RadioFX Studio` de 1100x760. Una primera ejecución usó `WEBKIT_DISABLE_DMABUF_RENDERER=1`; la reapertura del mismo perfil se verificó sin esa variable.

La lectura SQLite en modo solo lectura mediante `node:sqlite` de Node 22 confirmó `user_version=2`, banco Principal, revisión 0, maestro 0.7, límite 16 y preferencia de salida nula. El proceso terminó por SIGTERM del timeout, no mediante cierre normal validado. No hay captura visual válida ni afirmación de carga/interacción completa de la UI, IPC/CSP real o aceptación E2E.

Se observaron avisos ALSA sobre pulse/jack/oss durante enumeración: CPAL puede sondear hardware internamente. No se seleccionó un stream activo ni se reprodujo audio; no equivale a afirmar que la enumeración no tocó ningún dispositivo.

## Puerta pendiente

Quedan instalación/actualización/desinstalación, interacción nativa completa, hardware, accesibilidad integral, Windows/macOS y decisiones legales/de firma. La generación local del DEB no autoriza distribuirlo públicamente. Fase 6 es la última fase prevista: solicitar al titular confirmación legal/identidad y la aceptación física documentada, sin publicación automática ni una fase nueva inventada.
