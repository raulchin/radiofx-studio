# Fase 4: biblioteca y datos locales

## Estado y alcance

Fase 4 autorizada e implementada. Automatización y compilación Linux superadas; aceptación provisional con recorrido manual desktop y hardware pendientes. Fase 5 no autorizada. [PHASE_2.md](PHASE_2.md) y [PHASE_3.md](PHASE_3.md) permanecen intactos como registros históricos; los recuentos se añaden, no se reemplazan, en [VERIFICATION.md](VERIFICATION.md).

La entrega incorpora biblioteca, importación de archivos, asignaciones reproducibles y configuración durable. No incorpora búsqueda, atajos configurables, loops, fade, paquetes ni importación/exportación de bancos. Conserva orden/edición existentes, ahora persistentes, y STOP con Ctrl+Shift+Space dentro de la aplicación, no global del sistema.

## Comportamiento actual

1. En Tauri, `App` muestra `PersistentStudio`. Una biblioteca nueva contiene el banco Principal vacío: no se migran mocks anteriores, que nunca fueron durables. En navegador se muestra una demo explícita en memoria; no es fallback cuando SQLite falla.
2. **Importar audio** abre el selector desde Rust. Revisa cancelación, éxitos, duplicados y fallos por archivo; la selección admite hasta 256. Los archivos se copian al almacén, nunca se alteran ni borran los originales.
3. Crea/edita un botón y elige un recurso real. `id` de asignación y `effectId` son diferentes; duración calculada y de solo lectura, nombre/categoría/color personalizables. Límites de nombres en producción: banco 60, categoría 80, botón 100 caracteres.
4. Baja volumen físico/maestro, elige una salida y confirma **Seleccionar salida**. La preferencia guardada es solo un nombre: la coincidencia única es una sugerencia, no autoapertura; ausencia o ambigüedad exige elegir expresamente. Ningún arranque fuerza salida.
5. Cada clic crea otra voz, también del mismo efecto; cuenta voces reales. Límite inicial 16 configurable 1..64, rechazo sin robar voces. Parada por instancia/efecto y STOP conservan la semántica de Fase 3.
6. La edición espera ACK y un conflicto se muestra/recarga sin sobrescribir cambios ajenos. Durante importación/guardado/refresco se deshabilita edición, no disparos ya confirmados y disponibles ni paradas. Cerrar el modal no cancela IPC ya enviado.
7. **Actualizar biblioteca** revalida disco/hash. Sin watcher continuo: no se garantiza advertir cambios externos antes de refrescar. Una copia ausente/alterada se muestra y bloquea nuevos disparos, sin cortar voces ya fijadas.
8. Reimportar bytes sanos del mismo hash repara la copia con un UUID de archivo nuevo, conservando efecto, asignaciones, nombre y volumen; el resultado sigue siendo `duplicate: true`. La copia vieja no se sobrescribe ni elimina. No hay borrado de archivos de biblioteca; huérfanos conservados consumen disco.

## Persistencia y concurrencia

`app_data_dir/library.sqlite3`, SQLite bundled mediante rusqlite 0.40.2; audios en `audio/<uuid>.bin` con rutas relativas y hash SHA-256 (sha2 0.11.1). Migración `001_library.sql`, `user_version=1`, FK, CHECK, unicidad y transacciones. Versión futura, esquema desconocido/malformado o referencias inválidas se rechazan sin resetear datos del usuario.

Tablas: `sound_effects`, `sound_banks`, `bank_effects`, `categories`, `app_settings`, `diagnostic_volumes`. Persisten metadatos, asignaciones, categorías, posiciones, banco activo, columnas, maestro, límite, valores por defecto y nombre preferido. Ni bytes de audio en SQLite, ni voces/ganancias de instancia restauradas.

Solo el tablero usa revisión optimista. La comparación consulta SQL real y las recargas leen todas las tablas dentro de una transacción coherente; preferencias hacen patches SQL por campo, no escrituras de cache completa. Dos instancias pueden compartir datos y detectar conflictos sin perder preferencias ajenas; **no sincronizan globalmente sus motores**. La salida única es por motor/instancia de aplicación, nunca un stream por botón.

Maestro, límite y defaults se aplican primero al motor y luego a SQLite fuera del worker. `persistence_partial_failure` indica que el audio ya cambió si no pudo guardarse: no hay rollback ficticio. Importación confirma cada archivo aisladamente; ante fallo previo al commit revierte SQL y limpia solo copias nuevas propias. Huérfanos inesperados se conservan, no se infiere propiedad para borrarlos.

## Formatos y recursos

- Symphonia 0.5.5 con características `wav`, `pcm`, `mp3`, `ogg`, `vorbis`, `flac`. Fixtures reales de WAV PCM, MP3, OGG Vorbis y FLAC en `src-tauri/tests/fixtures/`, generados con FFmpeg 6.1.1 y leídos offline por los tests. No Opus ni garantía sobre toda variante de contenedor.
- Validación de extensión, firma, decoder y corrupción/truncamiento detectable. Máximos: 32 MiB de archivo, 32 MiB PCM por recurso, 120 s, 1..2 canales, 8..192 kHz, 4096 efectos y 256 archivos por importación. Los límites se combinan: no todo audio de 120 s cabe.
- Precarga completa acotada de todos los disponibles, **no LRU ni streaming**. Presupuesto PCM total de 128 MiB, incluidos 912000 bytes diagnósticos y reserva 32 MiB para adaptación de salida. El pool de entrada comparte Arc y reserva doble coste Vec/Arc más 2 MiB para bloques; el exceso es un error visible sin cortar recursos existentes.
- No es límite RSS: bytes del formato, probe/decoder, metadatos, estructuras y memoria del dispositivo quedan fuera. Conversión de salida materializada en CPU en worker, compartida y con temporales presupuestados, sin I/O/decoder en worker ni callback. Coste de primera conversión no medido.
- Corrección final: al invalidar PCM cambiado/no disponible se libera `conversion_inputs` obsoleto; conversiones ociosas se retiran y las activas siguen contabilizadas. Sincronización de hasta dos pases permite revalidar tras liberar pins. PCM antiguo activo puede bloquear hasta fin/STOP seguido de refresco, sin reselección de salida.
- Máximo 128 fuentes pendientes/retiradas si el render deja de consumir; `render_backpressure` rechaza nuevas voces e indica reseleccionar salida. No confundir con recuperación normal de presupuesto por STOP/refresco. Registrar tarde nunca reproduce ni rearma STOP; carga inicial rechaza play inmediatamente, sin disparo diferido.

La saturación suave de Fase 3 sigue siendo `0.95 * tanh(x / 0.95)`: protección numérica, no limitador transparente ni aceptación auditiva. STOP corta muestras futuras fuera de la cola, pero el driver puede demorar ACK/shutdown y los buffers de hardware no se retiran. No hay promesa de latencia física. Detalles en [AUDIO_ENGINE.md](AUDIO_ENGINE.md).

## Seguridad

El selector usa tauri-plugin-dialog 2.8.3 desde Rust: no rutas IPC ni filesystem genérico frontend. Diecisiete comandos de aplicación y escuchar/liberar eventos, solo para `main`; sin emisión frontend, shell, opener o permisos JS del diálogo. Los cuatro comandos nuevos son `get_library_snapshot`, `save_board`, `set_library_columns`, `import_audio_files`.

cap-std/cap-fs-ext 4.0.3 abren padres sin seguir enlaces, con descriptores fijados; entrada final nofollow/nonblock y archivo regular. Copias gestionadas con creación exclusiva y limpieza relativa al mismo directorio. No hay `unsafe` propio. SQLite abre separadamente con NOFOLLOW y comprobaciones de enlaces/sidecars: se presupone raíz de aplicación privada; no se promete inmunidad universal TOCTOU. No hay servicios de red en uso normal; obtener herramientas/dependencias de desarrollo puede requerir red.

## Archivos de Fase 4

Módulos creados para biblioteca y persistencia:

| Archivos                                                                                                       | Función                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `src-tauri/migrations/001_library.sql`                                                                         | Esquema inicial y seed Principal vacío.                 |
| `src-tauri/src/domain/library.rs`                                                                              | Contratos y PCM preparado.                              |
| `src-tauri/src/application/library.rs`                                                                         | Coordinación de biblioteca y sincronización.            |
| `src-tauri/src/infrastructure/library.rs`, `library/tests.rs`                                                  | SQLite, importación, reparación, memoria y regresiones. |
| `src-tauri/src/infrastructure/decoder.rs`, `filesystem.rs`                                                     | Decodificación y archivos acotados/seguros.             |
| `src-tauri/tests/fixtures/tone.wav`, `tone.mp3`, `tone.ogg`, `tone.flac`                                       | Audio codificado real de pruebas.                       |
| `src/shared/contracts/library.ts`, `src/shared/adapters/library.ts`                                            | Zod y cuatro comandos de biblioteca.                    |
| `src/features/sound-library/library-controller.ts`, `LibraryPanel.tsx`                                         | Cola de ACKs y biblioteca/importación.                  |
| `src/app/PersistentStudio.tsx`, `src/features/soundboard/usePersistentSoundboard.ts`                           | Vista persistente y coordinación separada.              |
| `tests/library-fixtures.ts`, `library-adapter.test.ts`, `library-controller.test.ts`, `persistent-ui.test.tsx` | Fixtures y pruebas frontend nuevas.                     |

Archivos integrados o modificados en Rust, con rutas relativas a `src-tauri/`: `Cargo.toml`, `Cargo.lock`, `build.rs`, `capabilities/default.json`, `src/lib.rs`, `src/commands/mod.rs`, `src/commands/ipc_tests.rs`, `src/application/engine.rs`, `src/application/engine/tests.rs`, `src/application/worker.rs`, `src/infrastructure/audio.rs` y módulos `mod.rs`. Integraciones frontend: `src/app/App.tsx`, `src/features/soundboard/Soundboard.tsx`, `src/features/sound-banks/BankManager.tsx`, `src/features/sound-library/ButtonEditor.tsx`, `src/features/audio-controls/NativeAudioControls.tsx` y `src/styles/global.css`.

Documentación actualizada: README, ARCHITECTURE, AUDIO_ENGINE, ROADMAP, VERIFICATION y ADR-001/002/003/004; este PHASE_4 es nuevo. PHASE_2/3 e históricos de verificación se preservan.

## Validación registrada

| Comprobación                        | Resultado                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm run check` con Node 22.23.3    | Correcto: tipos, lint, formato, 142 pruebas (78 anteriores + 64 nuevas) y build web.                                  |
| Formato Rust / Clippy `-D warnings` | Correctos.                                                                                                            |
| `cargo test --locked`               | 79 correctas (33 anteriores + 46 nuevas), 1 hardware ignorada. Incluye corrección final de pins/conversiones.         |
| `cargo build --locked`              | Correcto en Linux, sin acreditar ejecución GUI ni instaladores.                                                       |
| Chrome con APIs falsas              | UI de producción en 1440x1000, 390x844, 320x720; doble disparo, modal, importación y STOP sin errores/desbordamiento. |
| Repetición final de ambas cadenas   | Superada: tipos, lint, formato, 142 pruebas y build frontend; formato Rust, Clippy, 79 pruebas y build Linux.         |

SQLite y archivos son reales en tests de backend, pero temporales; audio usa driver simulado o fuentes/mezcla en memoria sin hardware. IPC usa handlers/ACL efectivos con runtime y transporte simulados, no WebView real. Frontend prueba persistencia/reinicio con APIs/repositorios falsos, no SQLite desde JavaScript. No se ejecutaron GUI desktop ni selector nativo ni se tocaron datos reales de usuario. Detalle de regresiones, cobertura y límites en [VERIFICATION.md](VERIFICATION.md).

## Comandos reproducibles

Con el entorno temporal existente, sin instalar globalmente ni reemplazar Node del sistema:

```bash
npm exec --yes --package=node@22 -- npm run check
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo cargo test --locked --manifest-path src-tauri/Cargo.toml
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo cargo build --locked --manifest-path src-tauri/Cargo.toml
```

Son comandos para reproducir las verificaciones finales ya superadas. Las rutas `/tmp/opencode` requieren que siga disponible ese entorno. `npm exec` puede consultar red si la herramienta no está cacheada; no es un servicio de ejecución del producto.

Para desarrollo desktop, únicamente después de preparar un perfil de pruebas aislado:

```bash
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo npm exec --yes --package=node@22 -- npm run tauri dev
```

El puerto Vite predeterminado es 1420; puede estar ocupado por un proceso del usuario. No detenerlo ni reutilizarlo sin autorización. Este comando no acredita que se haya realizado el recorrido GUI.

## Aceptación manual pendiente

No ejecutar durante una transmisión. Usar un perfil de usuario/sistema de pruebas cuya raíz `app_data_dir` esté identificada y separada de producción; no hay aquí un parámetro de override de raíz que deba suponerse existente. Respaldar el almacén con la aplicación cerrada antes de evaluar migraciones futuras; nunca ejecutar SQL destructivo ni cambiar `user_version` en datos del usuario. Las pruebas de esquema malformado pertenecen a bases temporales.

1. Arrancar desktop en el perfil aislado: Principal vacío, sin voces ni salida abierta, tampoco la predeterminada. Comprobar que errores de biblioteca no cargan mocks.
2. Seleccionar archivos de prueba propios WAV PCM/MP3/OGG Vorbis/FLAC, a volumen físico bajo. Revisar cancelación, importación mixta con un archivo corrupto, duplicado y selección/tamaño excesivos; conservar comprobación del original sin cambios.
3. Asignar un recurso, editar nombre/color/categoría y verificar duración de solo lectura, banco activo, posiciones y columnas. Confirmar guardados y mensajes de conflicto/recarga, sin sobrescribir desde otra instancia.
4. Elegir y confirmar salida autorizada con maestro bajo; disparar dos veces el mismo recurso, comprobar dos voces y parada por efecto/instancia. Probar STOP y Ctrl+Shift+Space desde modal e importación, sin esperar audio diferido al terminar.
5. Cerrar y reabrir: verificar biblioteca, asignaciones, orden, columnas, maestro, límite/defaults y nombre preferido conservados, pero cero voces y ninguna salida abierta. Confirmar manualmente incluso coincidencia única; verificar ausencia/ambigüedad sin fallback.
6. Solo sobre copias del perfil aislado, simular copia gestionada ausente/alterada y refrescar: aviso visible, recursos sanos utilizables. Reimportar original sano y comprobar mismo efecto/asignación/defaults con archivo UUID nuevo, sin sobrescritura ni borrado del anterior. Revisar el coste en disco de huérfanos conservados.
7. Bajo presupuesto ocupado por voces, parar y refrescar para revalidar sin reselección de salida. Medir por separado CPU/memoria y conversión en frío; las pruebas automáticas no sustituyen esta medición.
8. Completar checklist físico de Fase 3: USB/cambio/desconexión/restauración, calidad audible/transitorios/clipping y latencias. No probar 16 voces a máximo volumen sin validar antes niveles seguros. Windows/macOS, instaladores y accesibilidad integral siguen pendientes.

Registrar dispositivo, sistema, archivos, pasos y resultados sin convertir metas p95 < 50 ms en garantías. La prueba de hardware ignorada no se ejecutó y no debe activarse sin salida expresamente autorizada.

## Puerta siguiente

La implementación y su documentación quedan entregadas con las verificaciones automáticas superadas. Completar o aceptar explícitamente las limitaciones manuales para cerrar la aceptación de Fase 4. **Se requiere autorización explícita del usuario antes de iniciar Fase 5**; no se avanza automáticamente.
