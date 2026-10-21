# Fase 5: funciones profesionales

## Estado y alcance

Fase 5 autorizada e implementada: código de producto, UI, contratos, persistencia y pruebas para atajos configurables, loops, fades, búsqueda, reorganización y paquetes de bancos. La validación automática registrada está superada con las precisiones de recuentos siguientes. La aceptación manual desktop y física permanece pendiente. **Fase 6 no está autorizada y no se inicia automáticamente**.

PHASE_2/3/4 y los históricos de VERIFICATION se conservan intactos. No se añaden varias salidas, preescucha, MIDI, nube, streaming ni editor avanzado de ondas. ADR-001 no cambia: una sola salida por motor/instancia de aplicación.

## Uso y contratos

### Opciones y voces

Cada botón de producción guarda `playback: { looped, fadeInMs, fadeOutMs }`. Fades enteros de 0..30000 ms; en reproducción simple la suma debe caber en la duración real. Editar un botón afecta a disparos futuros; cada clic crea otra voz incluso del mismo recurso. `play_effect` conserva el disparo por defecto y se añade `play_effect_with_options`.

Loop recorre el mismo PCM adaptado compartido con cursor independiente, sin copiar cada vuelta ni crear buffers infinitos. El fade de entrada ocurre una vez. Desactivar loop termina la vuelta actual; el fade de cola configurado se aplica al final, no a cada vuelta. No hay crossfade ni garantía audible gapless.

La UI muestra `looped`, `state` (`playing`/`fading_out`) y `fade_out_ms` confirmados por Rust. `set_playback_loop` cambia loop por instancia; `fade_out_playback` inicia una salida explícita de 0..30000 ms. Cero corta; repetir no extiende ni revive. Una voz en fade ocupa capacidad hasta que el render consume la envolvente y la retira. Las envolventes son coherentes por frame/canales y avanzan según reloj de salida, no deadline de pared. Fade explícito retirado emite stopped; final natural, finished. Permanecen siete eventos de instantánea completa, sin frames de audio por IPC.

Las paradas por instancia/efecto/general y cambio/error de dispositivo cortan sin fade. STOP conserva el AtomicBool fuera de cola: no espera al worker ni a envolventes. Ambas rutas de play solo rearman al aceptar un nuevo disparo después de la barrera; voces retiradas no reviven. Un driver bloqueado puede retrasar ACK/shutdown, y no se retiran buffers ya enviados al hardware. No se promete silencio físico p95 < 50 ms.

### Atajos

Los atajos solo funcionan con la aplicación enfocada. No son globales del sistema operativo y no usan plugin de hotkeys. Cada binding contiene `id`, `scope: application|bank`, `scopeBankId`, `chord: { code, ctrl, alt, shift, meta }`, `action: { kind, targetId }` y `enabled`. Acciones: `play_button`, `select_bank`, `stop_all`.

- Máximo 512; Rust y TypeScript validan IDs, referencias, ámbito y conflictos. La identidad usa tecla física `code` y modificadores exactos, no el carácter impreso.
- Una combinación habilitada de aplicación colisiona con cualquier ámbito; dos bancos distintos pueden reutilizarla. Dos bindings habilitados del mismo banco no. Deshabilitados siguen validando estructura/referencias/reservas.
- Allowlist: letras, dígitos, F1..F12, Numpad0..9, Space y flechas, con reservas. Ctrl+Shift+Space es inmutable incluso con modificadores adicionales. Se reservan Ctrl/Meta+R/W/L/T/N/Q, F5 y Alt+F4.
- Un único listener raíz con `useEffectEvent` consulta el último ACK. Los ordinarios ignoran repetición, IME, AltGraph, campos editables/contenteditable y modales. Ctrl+Shift+Space se procesa antes y sigue operativo allí, sin listener de emergencia duplicado.
- Atajos importados permanecen deshabilitados salvo opt-in explícito. El opt-in respeta los que el exportador ya dejó deshabilitados; conflictos rechazan la importación completa.

### Búsqueda y traslado

Búsqueda local sin acentos/mayúsculas en banco activo o todos los bancos y en biblioteca; combina nombres de botón, categoría, banco y recurso cuando corresponde. Son vistas filtradas: no alteran orden guardado ni recuentos durables. DnD y flechas de orden se deshabilitan durante filtro/vista multibanco para evitar posiciones ambiguas.

Copiar a un banco crea ID de asignación nuevo, conserva recurso/opciones y no duplica archivos ni atajos. Mover conserva ID, requiere otro banco y avisa que elimina los atajos de disparo de esa asignación; traslado y eliminación se guardan atómicamente. Las operaciones esperan ACK y respetan conflicto de revisión, sin sobrescribir ni reenviar ediciones obsoletas.

## Persistencia y migración

Tablero de producción versión 2; demo en memoria versión 1 intacta. SQLite usa `user_version=2` mediante `002_professional.sql`, manteniendo `001_library.sql` inmutable. Añade loop/fades a `bank_effects` y `keyboard_shortcuts`. Los botones existentes reciben loop desactivado y fades cero. No hay fallback de producción que acepte tablero v1 por IPC.

La apertura usa transacción IMMEDIATE: comprueba versión y esquema de tablas antes de aplicar DDL a una base existente, compara el esquema final y verifica integridad/referencias antes del commit. La comparación lee tablas de `sqlite_master`, no audita universalmente triggers u otros objetos SQL. Versiones futuras/esquemas incompatibles se rechazan sin resetear ni migrar sus datos. Nombres/identificadores usan límites en puntos de código Unicode alineados entre Rust/TypeScript y la misma definición Unicode de texto no vacío.

Antes de migrar datos propios, cerrar **todas** las instancias, especialmente binarios antiguos v1, y respaldar el almacén cerrado. Probar sobre un perfil aislado identificado; no se supone que exista un flag de override de datos. No ejecutar SQL destructivo ni cambiar `user_version` manualmente en la biblioteca del usuario. Las pruebas maliciosas/de migración fallida pertenecen a bases temporales.

## Paquetes de bancos

### Formato y límites

Extensión `.rfxbank`, formato 1 con manifiesto JSON estricto:

```text
format: "radiofx-bank"
formatVersion: 1
banks: SoundBank[]
resources: { hash, name, format, defaultVolume }[]
keyboardShortcuts?: ShortcutBinding[]
```

Los `effectId` internos referencian hashes; IDs de bancos, botones y atajos son locales al paquete y se remapean al confirmar. Duración y audio se validan con decoder real. No exporta SQL, rutas locales, salida, maestro ni diagnósticos nativos. Incluye atajos solo si se elige esa opción.

`bank_archive.rs` implementa manualmente un **subconjunto cerrado ZIP Stored sin compresión**, revisado y cubierto por pruebas. No es un lector ZIP genérico ni se promete aceptar archivos ZIP de otras herramientas. No se añadió dependencia runtime: red no disponible y fuente ZIP no cacheada. No se simularon crates ni se alteraron checksums para evitar esa restricción.

- Máximo 256 MiB de paquete, manifiesto 2 MiB, 256 audios/257 entradas. Cada audio sigue limitado a 32 MiB de archivo/PCM, 120 s, 1..2 canales y 8..192 kHz, además del catálogo/presupuesto compartido.
- Nombres ASCII exactos `manifest.json` y `audio/<sha256 minúsculo>.<wav|mp3|ogg|flac>`. Nunca se extraen nombres del ZIP al filesystem.
- Se rechazan traversal, barras inversas, duplicados/colisiones de caso, enlaces/tipos especiales, extras, ZIP64, cifrado, compresión, descriptores de datos, comentarios y multidisco. Se comprueban cabeceras, directorio, CRC y hash.
- Decoder Symphonia para WAV PCM, MP3, OGG Vorbis y FLAC; no Opus ni todas las variantes. Un hash/formato/tamaño previamente validado puede reutilizar PCM conocido; otros recursos se decodifican con presupuesto libre. CRC/hash verifican integridad, **no autenticidad**.
- Presupuesto PCM total 128 MiB con diagnósticos y reserva de 32 MiB para adaptación, pins activos y preparación pendiente contabilizados; el mismo Arc no se cuenta dos veces. No LRU/streaming ni límite RSS. Exportar retiene bytes de recursos y ZIP codificado simultáneamente, cada conjunto acotado por 256 MiB, además del resto de memoria.

### Preparar y confirmar

**Importar bancos** abre el selector desde Rust, sin rutas/bytes IPC en JS. Primero valida el paquete completo y publica vista previa con bancos, recursos, botones, atajos y avisos; no guarda bancos ni reproduce durante preparación. Una lease atómica `IMPORT_PENDING`, liberada por Drop, permite una sola preparación pendiente en el proceso. Token de diez minutos con caducidad perezosa al acceder a biblioteca, no temporizador autónomo.

Cancelar, Escape, X y desmontaje invalidan la vista previa y liberan también tokens que respondan tarde. Un commit ya enviado no puede deshacerse cerrando el diálogo. Al confirmar se compara `expectedRevision` y se guardan todos los recursos, bancos, botones, opciones y atajos en una transacción. Los bancos y asignaciones se añaden con IDs nuevos; no se sobrescriben bancos existentes.

Recursos del mismo hash se reutilizan conservando nombre/defaults locales con aviso. Una copia gestionada dañada se repara con otro UUID de archivo, preservando identidad de efecto y archivo anterior. No se borran originales ni huérfanos ajenos. Ante fallo previo al commit revierte SQL y limpia solo nuevas copias propias. Registrar recursos nunca reproduce ni rearma STOP.

Atajos deshabilitados por defecto; activar requiere casilla explícita, y un conflicto rechaza toda la importación. Ante conflicto de revisión previo a aceptar el token, Rust lo retiene, pero la UI lo cancela y recarga: **revisar y volver a preparar**, sin repetir commit automáticamente. Tras aceptar el token se consume incluso ante fallo. Un error postcommit/registro comunica estado parcial: recargar antes de continuar, nunca reimportar a ciegas.

### Exportación sin sobrescritura

Seleccionar bancos y, opcionalmente, atajos; elegir un destino nuevo. El backend valida revisión y recursos, escribe temporal exclusivo con directorio fijado, sincroniza bytes y publica mediante hardlink sin reemplazo, limpiando su temporal. **Rechaza un destino existente incluso si el diálogo confirma sobrescritura**. No usa la secuencia insegura `exists`/rename ni fallback que reemplace. Si el filesystem no soporta hardlinks, devuelve error visible. No implica prueba de permisos/hardlinks en todas las plataformas.

## Archivos de implementación

| Grupo                     | Archivos principales creados o integrados                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio Rust                | `domain/audio.rs`, `application/engine.rs`, `application/worker.rs`, `infrastructure/audio.rs` y pruebas de engine/render                                                                                                                   |
| Datos y paquetes Rust     | `migrations/002_professional.sql`, `domain/library.rs`, `application/library.rs`, `infrastructure/library.rs`, `library/packages.rs`, `bank_archive.rs`, `filesystem.rs`                                                                    |
| IPC/ACL                   | `commands/mod.rs`, `commands/ipc_tests.rs`, `lib.rs`, `build.rs`, `capabilities/default.json`                                                                                                                                               |
| Atajos/búsqueda           | `src/features/keyboard-shortcuts/{contracts.ts,dispatch.ts,ShortcutPanel.tsx}`, `src/shared/search.ts`, `src/shared/contracts/text.ts`                                                                                                      |
| UI/control                | `PersistentStudio.tsx`, `usePersistentSoundboard.ts`, `Soundboard.tsx`, `ButtonEditor.tsx`, `LibraryPanel.tsx`, `BankPackages.tsx`, controladores de biblioteca/audio, `useNativeAudio.ts`, `NativeAudioControls.tsx`, `Modal.tsx`, estilos |
| Contratos/adaptadores     | `src/shared/contracts/{audio.ts,library.ts}`, `src/shared/adapters/{audio.ts,library.ts}`                                                                                                                                                   |
| Pruebas e infraestructura | `tests/`, tests internos Rust, `src-tauri/src/test_support.rs`, `Cargo.toml` y lock para retirar solo la dependencia de desarrollo no cacheada                                                                                              |

Las rutas Rust son relativas a `src-tauri/src/` salvo migración/configuración. Se conservan las pruebas anteriores, adaptando fixtures al tablero v2, sin fallback v1 de producción. No se modificó migración 001. Documentación actualizada: README, ARCHITECTURE, AUDIO_ENGINE, ROADMAP, VERIFICATION, ADR-002/003/004 y este PHASE_5; ADR-001 y PHASE_2/3/4 permanecen intactos.

## Validación registrada

| Comprobación              | Resultado registrado                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend con Node 22.23.3 | `npm run check` final superado: tipos, lint, formato, 233 pruebas en 15 archivos (142 anteriores + 91 nuevas) y build. Incluye las regresiones Unicode.     |
| Rust formato y Clippy     | Ejecución final superada: formato `--all --check` y Clippy `--all-targets -D warnings`, con `--locked --offline` en Clippy.                                 |
| Rust tests                | 110 correctas (79 anteriores + 31 nuevas), 1 de hardware ignorada; incluye cinco pruebas del helper temporal.                                               |
| Build nativo              | Linux correcto con `--locked --offline`; no instalador ni ejecución GUI.                                                                                    |
| Handlers/ACL              | 24 comandos de aplicación y escuchar/liberar eventos; contexto/ACL efectivos, runtime y transporte simulados. No WebView real.                              |
| Chrome con APIs falsas    | 1440x1000, 390x844 y 320x720; captura de atajos, búsqueda, paquetes/vista previa, modal, loop/fade y STOP sin errores JavaScript/desbordamiento horizontal. |

Pruebas backend con archivos/SQLite temporales reales y fixtures codificados; audio mediante driver falso o consumo de fuentes en memoria. No GUI Tauri, selectores nativos, audio físico ni datos reales del usuario. El recorrido Chrome fue comunicado por la revisión de implementación; no hay biblioteca permanente de capturas/Playwright que deba suponerse disponible en `/tmp`.

La revisión corrigió discrepancias Unicode entre longitud UTF-16 de JavaScript y puntos de código de Rust mediante `codePointString`, y entre definiciones de texto no vacío/trim mediante `.regex(/\P{White_Space}/u)` en nombres de producción e IDs de atajos. Esto conserva FEFF válido para Rust, a diferencia del criterio JavaScript `\S`, sin relajar controles de contenido. Las 16 pruebas Unicode están superadas e incluidas en las 233 de la ejecución final. También se cubren migración poblada/versión futura, ZIP malicioso, atomicidad, cancelación tardía, conflictos, deduplicación con conversión activa y presupuesto estrecho, loops/fades y emergencia.

El bloqueo offline inicial por `tempfile 3.27` ausente se resolvió retirando solo esa dependencia de desarrollo y sustituyéndola por helper `cfg(test)`: directorio raíz UUID exclusivo, 0700 en Unix, máximo ocho intentos y limpieza RAII de recursos propios, con cinco pruebas. No crate falso ni cambios de versiones/checksums ajenos. Los timeouts crates.io no son un bloqueo actual del build offline. Fallos iniciales de fixtures sobre trigger/presupuesto se corrigieron manteniendo comprobaciones significativas; no se ocultaron ni cuentan como éxitos.

## Comandos reproducibles

Rust/Cargo 1.99.1, rustfmt y Clippy existen en `$HOME/.cargo/bin`; Node 22.23.3 está cacheado en la ruta siguiente. Node 18 normal es incompatible. `/tmp/opencode` ya no contiene el tooling Rust anterior y no se afirma instalación global en esta sesión. Usar solo herramientas/dependencias existentes, sin source ni cambios globales:

```bash
env PATH="$HOME/.npm/_npx/d0a7a686d16af82b/node_modules/node/bin:$PATH" npm run check
env PATH="$HOME/.cargo/bin:$PATH" cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
env PATH="$HOME/.cargo/bin:$PATH" cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
env PATH="$HOME/.cargo/bin:$PATH" cargo test --locked --offline --manifest-path src-tauri/Cargo.toml
env PATH="$HOME/.cargo/bin:$PATH" cargo build --locked --offline --manifest-path src-tauri/Cargo.toml
```

Estos comandos reproducen las cadenas finales ya superadas: frontend con 233 pruebas en 15 archivos y build; Rust con formato, Clippy, 110 pruebas correctas, 1 hardware ignorada y build Linux. La caché Node es propia de esta máquina. Internet no está disponible de forma fiable; los intentos crates.io agotaron el tiempo de espera. No se requieren servicios en red durante el uso normal.

## Aceptación manual pendiente

Nunca probar durante una emisión. Perfil aislado, archivos de prueba propios, respaldo del almacén con **todas** las instancias cerradas y volumen físico/maestro bajo. No borrar raíces de datos ni ejecutar SQL destructivo en producción. No activar la prueba física ignorada sin salida expresamente autorizada.

1. Migrar una copia poblada v1 a v2 y reabrir desde desktop real. Verificar bancos, recursos, defaults y orden conservados; opciones/atajos guardados y recargados. Arranque sin voces ni salida abierta, incluso con preferencia única; errores no deben activar mocks.
2. Importar archivos de prueba por selector nativo, asignar dos botones al mismo recurso y disparar varias voces. Comprobar loop, fin de vuelta al desactivarlo y fades coherentes en ambos canales a nivel seguro. Escucha subjetiva no equivale a medir latencia ni garantizar gapless/clipping.
3. Comprobar fade explícito, repetición sin extensión y cupo ocupado hasta fin; STOP, parada individual/efecto y cambio de salida deben cortar sin esperar fade. Completar USB/desconexión/restauración y checklist de PHASE_3 cuando haya hardware autorizado.
4. Crear atajos por banco y aplicación, conflictos/reservas, distintos bancos con misma combinación, foco y último guardado. Verificar que campos, contenteditable, IME/AltGraph/repetición y modales no disparan acciones ordinarias; Ctrl+Shift+Space debe parar incluso en modal/campo. No atribuir funcionamiento con otra aplicación enfocada ni captura de teclas OS.
5. Buscar por nombre/categoría/recurso/banco y variar ámbito. Comprobar orden/recuentos conservados y reordenación deshabilitada con filtro/multibanco. Copiar sin duplicar archivos/atajos; mover con advertencia y eliminación atómica de bindings afectados.
6. Exportar bancos a nombre nuevo; incluir/excluir atajos. Elegir un destino existente y comprobar rechazo visible sin modificarlo, aun aceptando confirmación del diálogo. Verificar permisos y filesystem de destino; sin hardlinks debe haber error, no reemplazo.
7. Importar el paquete exportado: revisar vista previa, atajos deshabilitados por defecto, deduplicación/defaults locales y bancos añadidos sin sobrescribir. Cancelar mediante botón/Escape/X y cerrar antes de respuesta; poder volver a preparar sin preparación retenida. Confirmar no autoplay/rearme STOP.
8. Provocar conflicto de revisión solo en perfil de prueba: recarga y nueva preparación obligatorias, sin commit repetido. Revisar mensajes de error parcial sin reimportar automáticamente. Con opt-in de atajos en conflicto, no deben quedar cambios parciales.
9. Solo en perfil aislado, intentar paquetes inválidos/no admitidos, hash/CRC incorrectos y límites excesivos. Comprobar rechazo atómico, originales intactos y ausencia de sobrescrituras; no modificar datos reales para fabricar fallos. Validar reparación de copia gestionada con otro UUID sin borrar la anterior.
10. Registrar sistema, dispositivo, formatos, pasos/resultados y riesgos. Windows/macOS, instaladores, benchmarks de CPU/RSS/latencia, accesibilidad integral e identidad/iconos siguen sin validación. No convertir metas p95 < 50 ms en resultados.

## Puerta siguiente

Implementación Fase 5 entregada con resultados automáticos registrados y limitaciones explícitas. Completar o aceptar expresamente los pendientes manuales para cerrar su aceptación. **Se solicita autorización explícita antes de Fase 6**; no se generan instaladores, se abren salidas físicas ni se continúa a distribución automáticamente.
