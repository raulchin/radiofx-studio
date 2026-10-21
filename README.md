# RadioFX Studio

Paleta de efectos para radio, podcasts, streaming y eventos, orientada a escritorio en Linux, Windows y macOS. El uso normal es local y offline, sin cuentas ni servicios remotos obligatorios.

## Estado y alcance

La Fase 1 fue aceptada y las Fases 2/3/4/5 están implementadas. La **Fase 6 está autorizada y parcialmente validada**: calidad automatizada Linux, benchmark de software offline y generación e inspección de un DEB de prueba superadas. También se comprobó el arranque y reapertura del proceso desktop en un perfil aislado, no su recorrido interactivo completo. **Fase 6 no está cerrada y la publicación está bloqueada** por licencia/titular/publisher, identidad final, firmas, plataformas y aceptación manual/hardware pendientes. No hay publicación automática.

La aplicación distingue estos espacios:

- **Escritorio Tauri:** biblioteca persistente, inicialmente un banco **Principal** vacío. Importa copias locales y asigna recursos reales a botones; cada clic inicia el efecto desde cero, sustituyendo sus voces anteriores sin cortar otros efectos. Un fallo de SQLite se muestra, nunca se sustituye por datos mock.
- **Navegador:** demo explícita en memoria, sin persistencia ni reproducción de archivos de producción. Sus datos anteriores no se migran: antes de Fase 4 no existía almacenamiento durable.
- **Diagnóstico nativo:** tres señales PCM Rust en un apartado opcional separado. No se abre una salida ni se reproduce audio al arrancar, tampoco al recuperar preferencias.

Stack: Tauri 2, React 19, TypeScript 6 estricto, Vite 8, Tailwind CSS 4, Zod 4 y Zustand 5 para la demo. Audio: **Rodio 0.21.1** con solo `playback`, **CPAL 0.16** transitivo y UUID. Fase 4 añade **rusqlite 0.40.2** con SQLite bundled, **Symphonia 0.5.5**, **sha2 0.11.1**, **tauri-plugin-dialog 2.8.3**, **cap-std/cap-fs-ext 4.0.3** y coordinación Tokio. `src-tauri/Cargo.lock` fija las dependencias. No hay servicio remoto de ejecución; preparar dependencias de desarrollo puede requerir red.

## Uso

1. Abre la aplicación desktop para usar la biblioteca real. `npm run dev` sin Tauri ofrece solo la demo en memoria.
2. En el panel nativo, baja el volumen físico y el maestro antes de probar. Elige el dispositivo y pulsa **Seleccionar salida**. La marca de salida predeterminada es informativa, no una selección automática.
3. Usa **Importar audio**, elige archivos en el selector nativo y revisa éxitos, duplicados, cancelación y fallos parciales. Crea o edita un botón y asigna el recurso importado; nombre, categoría y color son editables, la duración procede del audio y es de solo lectura. Repetir un efecto lo reinicia desde cero con un `playback_id` nuevo, sin acumular copias ni alternar pausa/reproducción. Los efectos distintos siguen mezclándose.
4. Ajusta el maestro, la ganancia de una instancia o el valor por defecto de un efecto. Este último solo afecta a voces futuras. El límite empieza en 16 y admite enteros 1..64 mediante **Aplicar límite** o Enter; se muestra por separado el valor confirmado por Rust.
5. Detén una instancia, todas las de un efecto o usa **STOP ALL · audio nativo**. **Ctrl+Shift+Space** ejecuta la parada nativa incluso dentro de un diálogo, mientras la aplicación tiene el foco. No es un atajo global del sistema operativo.
6. Bancos, asignaciones, posiciones, categorías, banco activo, columnas, maestro, límite y valores por defecto se guardan localmente. La edición espera confirmación; un conflicto se muestra y recarga sin sobrescribir cambios ajenos. Durante I/O de biblioteca se deshabilita la edición, no los disparos ya disponibles ni las paradas. Cerrar un diálogo no cancela una operación ya enviada.
7. En el editor de botón configura loop y fades de entrada/salida de 0..30000 ms; en reproducción simple ambos deben caber en la duración real. Cada clic reinicia también el cursor y las envolventes, cortando las voces anteriores del efecto aunque estén en loop o fade. Desactivar loop termina la vuelta actual; el fade explícito mantiene la voz ocupada hasta que el render termina. Las paradas normales y STOP cortan sin fade.
8. Configura atajos para disparar botones, seleccionar bancos o parar todo, con ámbito de aplicación o banco. Solo funcionan con la aplicación enfocada, no globalmente en el sistema. Los ordinarios se ignoran en campos y modales; Ctrl+Shift+Space permanece reservado y operativo también allí.
9. Busca en el banco activo, todos los bancos o la biblioteca, sin distinguir mayúsculas ni acentos. Filtrar no altera el orden guardado; arrastre y flechas de orden se deshabilitan con filtro o vista multibanco. Copiar una asignación crea otro ID sin duplicar audio ni atajos; mover avisa y elimina sus atajos de disparo en el mismo guardado.
10. Exporta bancos a un destino **nuevo** `.rfxbank`: nunca se sobrescribe un archivo existente, aunque el selector permita confirmarlo. Para importar, elige un paquete, revisa la vista previa y confirma; los atajos quedan deshabilitados salvo opt-in explícito. Cancelar/cerrar libera la preparación; un conflicto exige revisar la recarga y volver a preparar, sin reintento automático.

Cambiar la salida detiene las voces, cierra el stream anterior e intenta abrir el solicitado. Si falla, intenta restaurar la anterior sin reanudar voces. No hay redirección silenciosa. Actualizar dispositivos renueva los tokens, sin alterar la salida abierta. Solo se persiste el nombre: una coincidencia única se indica como sugerencia, pero exige elección y confirmación explícitas; un nombre ausente o ambiguo nunca provoca apertura ni fallback automático.

La guía funcional y el formato de paquetes están en [PHASE_5.md](docs/PHASE_5.md). El estado de validación vigente está en [PHASE_6.md](docs/PHASE_6.md), los paquetes y bloqueos en [RELEASE.md](docs/RELEASE.md) y la aceptación pendiente en [HARDWARE_TESTS.md](docs/HARDWARE_TESTS.md). PHASE_2/3/4/5 conservan sin cambios sus alcances y resultados históricos.

## Entorno y ejecución

Requisitos: Node.js `>=22.13 <23` o `>=24` (recomendado Node 22), npm, Rust estable con Cargo, rustfmt y Clippy, y prerrequisitos de Tauri 2 por plataforma. El crate usa edición 2024. En Linux se necesitan las bibliotecas de desarrollo de GTK/WebKit, ALSA y las herramientas de compilación correspondientes. Preparar dependencias puede requerir red; el uso normal no.

Con Node 22 y Rust ya disponibles en el entorno, desde la raíz:

```bash
npm ci
npm run dev
```

Para escritorio, en lugar del servidor web aislado:

```bash
npm run tauri dev
```

En el entorno Linux actual Rust/Cargo 1.99.1, rustfmt y Clippy existen en `$HOME/.cargo/bin`. Node 22.23.3 está cacheado en la ruta siguiente; Node 18 del PATH habitual es incompatible. Para usar las herramientas existentes sin red ni modificar el entorno global:

```bash
env PATH="$HOME/.npm/_npx/d0a7a686d16af82b/node_modules/node/bin:$HOME/.cargo/bin:$PATH" CARGO_NET_OFFLINE=true npm run tauri dev
```

La caché Node es específica de esta máquina, no un requisito del producto. Las herramientas temporales de Rust bajo `/tmp/opencode` usadas en fases anteriores ya no están disponibles. No se instalaron herramientas globales en esta sesión. `.nvmrc` y `scripts/toolchain.json` fijan la referencia Node 22.23.3; este último también registra Rust 1.99.1 para CI. No hay `rust-toolchain` que fuerce una descarga local. No usar datos de producción para probar la migración.

## Comandos y validación

| Comando                     | Función                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `npm run dev`               | Servidor frontend sin puente nativo.                                               |
| `npm run typecheck`         | TypeScript estricto.                                                               |
| `npm run lint`              | ESLint sin advertencias.                                                           |
| `npm run format:check`      | Comprobar Prettier sin editar.                                                     |
| `npm run format`            | Aplicar Prettier; modifica archivos.                                               |
| `npm test`                  | Ejecutar Vitest una vez.                                                           |
| `npm run test:watch`        | Vitest en observación.                                                             |
| `npm run build`             | Tipos y build frontend Vite.                                                       |
| `npm run check`             | Tipos, lint, formato, pruebas y build.                                             |
| `npm run check:all`         | Cadena frontend, rustfmt, Clippy y tests Rust; Cargo offline y locked por defecto. |
| `npm run bench:audio`       | Benchmark opt-in release sin dispositivo; imprime JSON.                            |
| `npm run release:preflight` | Verifica metadatos/ACL y muestra bloqueos; no autoriza publicar.                   |
| `npm run bundle:linux`      | Genera únicamente DEB de prueba sin firma en Linux.                                |
| `npm run release:artifacts` | Manifiesto de integridad exclusivo, sin sobrescritura.                             |
| `npm run preview`           | Servir el build web.                                                               |
| `npm run tauri dev`         | Desarrollo desktop con Rust y prerrequisitos nativos.                              |

Comprobaciones con Rust ya disponible:

```bash
env PATH="$HOME/.cargo/bin:$PATH" cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
env PATH="$HOME/.cargo/bin:$PATH" cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
env PATH="$HOME/.cargo/bin:$PATH" cargo test --locked --offline --manifest-path src-tauri/Cargo.toml
env PATH="$HOME/.cargo/bin:$PATH" cargo build --locked --offline --manifest-path src-tauri/Cargo.toml
```

Validación frontend con Node cacheado, sin sustituir Node 18 ni consultar npm por red:

```bash
env PATH="$HOME/.npm/_npx/d0a7a686d16af82b/node_modules/node/bin:$PATH" npm run check
```

Resultados finales de Fase 5: `npm run check` superado con Node 22.23.3 cacheado, incluidos TypeScript, ESLint, Prettier, **233 pruebas en 15 archivos** (142 anteriores + 91 nuevas) y build frontend. Rust: **110 pruebas superadas y 1 de hardware ignorada** (79 anteriores + 31 nuevas), formato `--all --check`, Clippy `--all-targets -D warnings` y build Linux correctos con `--locked --offline` donde corresponde. Ambas cadenas finales están superadas, incluidas las regresiones Unicode. El build nativo no acredita arranque GUI, IPC desde una WebView real ni audio físico. Los recuentos históricos de Fase 4 se conservan en su registro.

En Fase 6 los resultados acumulados registrados son **264 pruebas frontend en 16 archivos** y **116 Rust correctas, 2 ignoradas** (hardware y benchmark opt-in). Tipos, lint, formato, Clippy all-targets y comprobaciones normales superados. La cadena principal inicial tenía 254 frontend; tras las diez regresiones finales de metadatos, la revisión independiente ejecutó las 264 correctamente. No confundir aquel recuento inicial con el actual. Comandos, benchmark y límites de evidencia en [PHASE_6.md](docs/PHASE_6.md).

```bash
env PATH="$HOME/.cargo/bin:$HOME/.npm/_npx/d0a7a686d16af82b/node_modules/node/bin:$PATH" npm run check:all
```

`check:all`, `bench:audio` y los bundles admiten `--dry-run` y `--online`; este último permite preparar dependencias con red de forma explícita. Las herramientas no instalan Node/Rust localmente. La preparación CI/build puede usar red, no el funcionamiento normal del producto.

La UI de producción de Fase 5 se revisó en Chrome a 1440x1000, 390x844 y 320x720 con APIs falsas: captura de atajos, búsqueda, paquetes/vista previa, modal, loop/fade y STOP, sin errores JavaScript ni desbordamiento horizontal. No prueba SQLite desde WebView ni el selector nativo. Detalle y registros históricos inalterados en [VERIFICATION.md](docs/VERIFICATION.md).

## Seguridad y límites

- Rust es la fuente de verdad. Veinticinco comandos tipados (17 de audio y 8 de biblioteca/paquetes) y siete eventos de instantánea completa se validan con Zod; no hay voces ni guardados optimistas ni audio mediante `HTMLAudioElement`, ni frames de audio por IPC.
- Una sola salida y mezcla común por motor/instancia de aplicación; no un stream por efecto. Dos procesos comparten datos SQLite, no sincronizan globalmente sus motores. Límite inicial 16: una voz adicional se rechaza visiblemente sin robar voces; reiniciar un efecto ya activo reutiliza su cupo incluso con el límite lleno.
- `STOP ALL` activa un corte atómico en el render, sin depender del avance del worker. Su confirmación espera detener voces y cancelar la cola. Una llamada bloqueada del driver puede retrasar la confirmación y el cierre; los buffers ya enviados al hardware no pueden retirarse. No se promete latencia física.
- La protección común `0.95 * tanh(x / 0.95)` acota picos numéricos después del maestro, pero colorea el sonido; **no es un limitador transparente**. La calidad audible, el clipping real y las latencias siguen sin medir.
- ACL limitada a `main`, los veinticinco comandos y escuchar/liberar eventos. El selector se invoca desde Rust: no se aceptan rutas IPC ni se conceden permisos generales de filesystem, diálogo o emisión frontend. Las pruebas ejercitan handlers/ACL con runtime y transporte simulados, no una WebView real.
- CSP local de producción; desarrollo permite localhost para Vite. Sin plugin opener ni permisos generales de archivos/shell. Identificador `com.chinlabsgroup.radiofx-studio` y versión `0.1.0` conservados. Icono SVG original provisional y derivados sustituyen la plantilla; identidad final y derechos pendientes de confirmación por el titular.
- Formatos comprobados con fixtures reales: WAV PCM, MP3, OGG Vorbis y FLAC; OGG Opus y todas las variantes posibles no están cubiertas. Se validan extensión, firma y decoder; se rechazan corrupciones/truncamientos detectables.
- Límites: 32 MiB de archivo y 32 MiB PCM por recurso, 120 s, 1..2 canales, 8..192 kHz, 4096 efectos y 256 archivos por importación. Precarga completa acotada, no LRU ni streaming: presupuesto PCM total de 128 MiB con diagnósticos, temporales y reserva de adaptación de salida; **no es un límite de RSS**. Detalles en [AUDIO_ENGINE.md](docs/AUDIO_ENGINE.md).
- `app_data_dir/library.sqlite3` y copias `audio/<uuid>.bin`, rutas relativas y deduplicación SHA-256. Nunca se modifica ni borra el original. **Actualizar biblioteca** revalida disco/hash; no hay watcher continuo. Reimportar el original sano repara una copia ausente o alterada conservando efecto/asignaciones, mediante otro UUID de archivo, sin sobrescribir ni borrar el anterior. No hay borrado de archivos de biblioteca en Fase 4; los huérfanos se conservan y consumen espacio.
- Windows/macOS y accesibilidad integral no validados. Linux tiene DEB de prueba generado e inspeccionado, no instalado ni probado en actualización/desinstalación. No ejecutar pruebas destructivas sobre datos de usuario ni una cabina en emisión.
- Tablero de producción v2 y migración SQLite 002 sobre 001 inmutable. Respaldar con todas las instancias cerradas, especialmente versiones v1, y probar primero en un perfil aislado. La demo sigue en v1.
- `.rfxbank` formato 1 usa un codec propio mínimo ZIP Stored, implementado y probado, **no compatibilidad ZIP genérica**. Máximo 256 MiB, manifiesto 2 MiB, 256 audios/257 entradas, CRC/hash y decoder real; sin compresión, enlaces, ZIP64 ni extracción de nombres a disco. El hash comprueba integridad, no autenticidad. La exportación exige soporte de hardlinks para publicar sin reemplazo; falla visiblemente si no existe. No se añadieron dependencias runtime en Fase 5.

## Documentación

- [Arquitectura](docs/ARCHITECTURE.md)
- [Motor de audio](docs/AUDIO_ENGINE.md)
- [Roadmap y puertas](docs/ROADMAP.md)
- [Fase 6 y benchmark offline](docs/PHASE_6.md)
- [Paquetes y bloqueos de publicación](docs/RELEASE.md)
- [Aceptación desktop y hardware](docs/HARDWARE_TESTS.md)
- [Fase 5: funciones profesionales y aceptación](docs/PHASE_5.md)
- [Fase 4: biblioteca, persistencia y aceptación](docs/PHASE_4.md)
- [Fase 3: alcance, uso y aceptación física](docs/PHASE_3.md)
- [Fase 2: registro histórico de la paleta mock](docs/PHASE_2.md)
- [Verificación](docs/VERIFICATION.md)
- [ADR-001: salida única](docs/DECISIONS/ADR-001-single-output.md)
- [ADR-002: concurrencia](docs/DECISIONS/ADR-002-concurrent-playback.md)
- [ADR-003: autoridad Rust](docs/DECISIONS/ADR-003-backend-state.md)
- [ADR-004: datos locales](docs/DECISIONS/ADR-004-local-data.md)

Las reglas están en [AGENTS.md](AGENTS.md). La aceptación manual heredada de Fases 3/4/5 sigue pendiente dentro de Fase 6. La siguiente decisión corresponde al titular: confirmar aspectos legales y de identidad, acordar las pruebas físicas y resolver la publicación; no hay una Fase 7 ni autorización implícita para publicar.

## Corrección: reinicio al repetir un efecto

Por requisito explícito del usuario, los botones nativos, sus atajos y el diagnóstico usan `restart_effect({ effectId, options }) -> playback_id`, con `options: PlaybackOptions`. El reinicio es global por `effect_id` dentro del motor: dos botones que asignen el mismo recurso, incluso en bancos distintos, se reinician entre sí. No exige cambios de esquema SQLite ni de opciones por asignación. La demo sigue siendo solo visual y no acredita este comportamiento nativo.

Rust valida recurso, opciones, volumen por defecto, salida, disponibilidad de PCM y cupo antes de cortar. Después detiene todas las voces anteriores de ese efecto, incluidas loop/fade, e inicia una nueva desde cero con el volumen por defecto vigente y las opciones del disparo. Si el driver falla después del corte, las anteriores no se restauran: se muestra el error y los demás efectos continúan. Los buffers ya entregados al sistema operativo/hardware no pueden retirarse.

`play_effect` y `play_effect_with_options` conservan la superposición explícita del mismo recurso para el núcleo, benchmarks y API de bajo nivel; no son la ruta normal de los botones. Cambia la política de despacho, no la capacidad multivoz del dominio.

Validación final con Node 22.23.3 y Rust 1.99.1: `npm run check:all` superado, con 266 pruebas frontend en 16 archivos, 122 Rust correctas y 2 ignoradas, rustfmt y Clippy all-targets sin advertencias. `npm run bundle:linux` superado: release Linux y DEB reconstruidos con la corrección, versión `0.1.0`, sin firma y solo de prueba. Detalle en [VERIFICATION.md](docs/VERIFICATION.md#corrección-reinicio-al-repetir-un-efecto) y hash/manifiesto vigentes en [RELEASE.md](docs/RELEASE.md#artefacto-vigente-con-la-corrección). El paquete no se instaló: una instalación anterior no se actualiza automáticamente y debe usar la aplicación actualizada para incorporar el cambio. No se realizaron pruebas GUI, auditivas o de hardware para esta corrección. No se abre otra fase ni se autoriza publicación.
