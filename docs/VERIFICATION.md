# Verificación de Fase 1

## Entorno

- Fecha de la sesión: 19 de octubre de 2026.
- Linux Mint 22.2, x86_64. No se detecta repositorio Git; no se crean commits.
- Node del sistema: 18.19.1; npm: 9.2.0. Node 18 no satisface Vite 8 ni las herramientas de calidad elegidas.
- Node temporal mediante `npm exec --yes --package=node@22 -- ...`: 22.23.3. No se reemplaza Node del sistema.
- `rustc`, `cargo` y `rustup` no disponibles; tampoco existe el directorio habitual `~/.cargo/bin`.
- `pkg-config --modversion gtk+-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 openssl` devuelve respectivamente 3.24.41, 2.52.3, 2.52.3, 3.4.4 y 3.0.13.
- `npm run tauri -- info`, con Node temporal, detecta WebKitGTK y señala ausencia de `rsvg2`, Rust y Cargo. Su código de salida 0 no equivale a prerrequisitos completos.

## Comprobaciones realizadas

Los comandos npm de esta tabla se ejecutan con el prefijo `npm exec --yes --package=node@22 --`.

| Comando                                                                          | Resultado                                                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm install`                                                                    | Dependencias y `package-lock.json` actualizados; auditoría de 199 paquetes, 0 vulnerabilidades comunicadas. |
| `npm run typecheck`                                                              | Correcto; aplicación, pruebas y configuraciones TypeScript estrictas.                                       |
| `npm run lint`                                                                   | Correcto, sin advertencias.                                                                                 |
| `npm test`                                                                       | 2 archivos y 7 pruebas correctas.                                                                           |
| `npm run build`                                                                  | Correcto; genera `dist/` con Vite 8 y Tailwind 4.                                                           |
| `npm run tauri -- info`                                                          | Diagnóstico completado; faltan prerrequisitos nativos indicados arriba.                                     |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                         | Bloqueado: `cargo: orden no encontrada`.                                                                    |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Bloqueado: `cargo: orden no encontrada`.                                                                    |
| `cargo test --manifest-path src-tauri/Cargo.toml`                                | Bloqueado: `cargo: orden no encontrada`.                                                                    |

La ejecución completa de `npm run check` pasó: tipos, lint, formato Prettier, 7 pruebas y build. `npm ls --depth=0` también finalizó correctamente, sin dependencias inválidas. No se presenta el build web como una compilación de Tauri.

El primer comando de formato enumeró por error `.prettierignore`, que no tiene parser; los archivos de código se formatearon y la comprobación posterior `prettier --check .` pasó sin errores. No se modificó `AGENTS.md`.

## Cobertura

- Contrato Zod: acepta la instantánea inicial y rechaza campos extra, estado incompatible, dispositivo ficticio, voces no vacías y límite incorrecto.
- Adaptador: comprueba el comando de solo lectura, valida el payload, propaga fallos IPC y rechaza el navegador sin fingir conexión nativa.
- Pantalla: renderizado React sin navegador, identificación del producto, aviso de audio no implementado, botón de consulta y región de estado; ausencia de controles de reproducción.
- Dos pruebas Rust preparadas, pero no ejecutadas: estado inicial del caso de uso y serialización exacta del DTO IPC.
- El renderizado estático no prueba interacción DOM, foco real, disposición visual ni un intercambio IPC con Tauri.

## Pendientes y riesgos

- Preparar Rust estable con rustfmt y Clippy y completar los prerrequisitos nativos Linux, incluido `rsvg2`. No se instalan herramientas globales ni paquetes del sistema en esta sesión.
- Ejecutar formato, Clippy, pruebas y compilación Tauri; resolver dependencias y generar `src-tauri/Cargo.lock`. No hay versiones Rust resueltas ni compatibilidad nativa certificada.
- Se ha contrastado la API `AppManifest::new().commands(...)` con la documentación publicada de `tauri-build` 2.7.3; esto no sustituye compilar y comprobar ACL reales.
- Verificar manualmente inicio desktop, consulta nativa, CSP/ACL, foco, teclado, lector de pantalla y presentación en anchos desktop y móvil. Sin pruebas visuales en navegador ni pruebas de hardware en esta sesión.
- La CSP de producción no permite scripts inline; la de desarrollo permite scripts y estilos inline para Vite/React y WebSocket solo en localhost. Un host de desarrollo remoto necesita una política explícita; no se habilitan comodines de red.
- No se ha probado Windows ni macOS, instaladores o identidad visual final. Se mantienen identificador e iconos existentes.
- Sin audio real, SQLite, importación ni persistencia. Rodio/CPAL, formatos y latencias quedan sin evaluar o medir, según la fase correspondiente.

## Puerta de aprobación

La implementación de Fase 1 queda entregada con validación frontend y bloqueo de validación nativa claramente registrado. No se declara validación integral del escritorio. No iniciar Fase 2 sin autorización explícita del usuario.

---

# Verificación de Fase 2

## Aprobaciones y alcance

Registro añadido el 19 de octubre de 2026. Se conserva arriba el historial de Fase 1 tal como se entregó: posteriormente el usuario aceptó Fase 1 y autorizó Fase 2. No se reabre esa aceptación ni se convierte el bloqueo histórico en validación nativa superada. Fase 3 espera autorización explícita.

Esta sección recoge los resultados de implementación y pruebas de Fase 2. La cadena completa `npm run check` pasó con Node 22.23.3 temporal: tipos, lint, formato, 50 pruebas y build web.

## Entorno y comandos

Validaciones frontend con Node 22.23.3 temporal, sin reemplazar Node 18 del sistema. Los comandos npm de validación usan `npm exec --yes --package=node@22 --`.

| Comando o comprobación                     | Resultado de Fase 2                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `npm install`                              | 249 paquetes auditados, 0 vulnerabilidades comunicadas; advertencia por `whatwg-encoding` transitivo obsoleto.    |
| `npm run typecheck`                        | Superado individualmente.                                                                                         |
| `npm run lint`                             | Superado individualmente.                                                                                         |
| `npm test`                                 | 4 archivos y 50 pruebas superados con Node 22.23.3 temporal.                                                      |
| `npm run build`                            | Superado individualmente; build web, no compilación Tauri.                                                        |
| `npm run check` final                      | Superado: TypeScript, ESLint sin advertencias, Prettier, 50 pruebas y build frontend.                             |
| Vite con `--host 127.0.0.1 --port 1425`    | Demo servida para la revisión en navegador; 1420 ocupado, servicio existente no modificado.                       |
| Playwright temporal con Chrome del sistema | Recorrido web y capturas revisadas en los tres tamaños indicados abajo. Sin dependencia permanente de Playwright. |

Un test inicial de arranque falló porque esperaba la pantalla obsoleta de Fase 1; se actualizó para la paleta y el diagnóstico en Configuración. Un intento de `npm test` desde un agente usó Node 18 y falló antes de ejecutar pruebas; la repetición completa con Node 22 pasó. Esos intentos no se cuentan como ejecuciones correctas.

## Cobertura automatizada

| Grupo                       | Pruebas | Alcance                                                                                                                                 |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Contrato/adaptador de audio | 6       | Conservadas: instantánea inicial validada y límites del adaptador nativo.                                                               |
| Arranque                    | 2       | Actualizadas: paleta sin audio nativo y diagnóstico de Settings mediante renderizado estático.                                          |
| Store de paleta             | 31      | Zod, límites de nombre/categoría/banco 100/60/80, identidades, CRUD, orden, atomicidad ante fallos de guardado, estados demo y volumen. |
| Interacción UI              | 11      | Interacciones DOM de la paleta con Testing Library y jsdom.                                                                             |
| Total                       | 50      | 4 archivos, todos superados con Node 22.23.3 temporal.                                                                                  |

Las dependencias incorporadas son Zustand 5.0.15 y, en desarrollo, Testing Library React 16.3.3, DOM 10.4.2, user-event 14.6.8 y jsdom 26.1.0. No se incorporaron librerías de DnD/UI ni Playwright al manifiesto. La auditoría npm no acredita seguridad integral.

## Navegador real

| Chrome del sistema | Resultado                                                                  |
| ------------------ | -------------------------------------------------------------------------- |
| 1440×1000          | Carga y captura desktop revisadas; sin desbordamiento horizontal.          |
| 390×844            | Carga y captura móvil revisadas; sin desbordamiento horizontal.            |
| 320×720            | Carga y captura de ancho pequeño revisadas; sin desbordamiento horizontal. |

En los tres tamaños se comprobó creación de botón y color, estados demo, `STOP ALL`, 20 pasos de Tab y 20 de Mayús+Tab contenidos en el modal, Escape y retorno de foco, sin errores JavaScript. Se comprobó también arrastre nativo en desktop. No se usaron dispositivos móviles físicos. La matriz y el manual están en [PHASE_2.md](PHASE_2.md).

La primera comprobación ampliada de tabulación detectó que el diálogo nativo permitía salir del ciclo hacia el navegador. Se añadió el cierre explícito del ciclo Tab/Mayús+Tab; la repetición en Chrome y la regresión DOM pasaron. Al borrar el control de origen, el foco vuelve al encabezado de la paleta.

Evidencia temporal fuera del repositorio: `/tmp/opencode/radiofx-phase2-{desktop,mobile,small}.png` y `/tmp/opencode/radiofx-phase2-browser.cjs`. Las tres capturas válidas proceden de `127.0.0.1:1425` y fueron revisadas. Las capturas iniciales accidentales del puerto 1420 estaban en blanco y se descartaron. No se conserva infraestructura permanente de Playwright en el proyecto.

## Límites y pendientes

- Comprobación frontend conjunta superada; no sustituye una compilación nativa.
- Sin cambios en el adaptador nativo, contratos de audio, Rust ni capabilities; no se repiten pruebas Rust en esta fase de UI.
- Rust, Cargo y `rsvg2` ausentes son resultados históricos de Fase 1, no un diagnóstico vuelto a ejecutar en Fase 2.
- Sin compilación o arranque Tauri, IPC real, validación nativa CSP/ACL, Windows ni macOS probados. Chrome web no acredita esas plataformas.
- Sin audio real, importación, SQLite ni persistencia al recargar. El repositorio síncrono en memoria deberá adaptarse al IPC asíncrono en Fase 4.
- Sin pruebas de hardware, mediciones de latencia, voces simultáneas, mezcla o clipping. El contador visual mide botones demo, no voces; las reproducciones reales son 0 y el motor no está inicializado.
- Pendiente una auditoría completa de accesibilidad y pruebas con lector de pantalla; el recorrido de foco y los tests DOM no la sustituyen.

La siguiente puerta es la autorización explícita del usuario para **Fase 3**. No se implementa ni se inicia audio nativo en esta entrega.

---

# Verificación de Fase 3

## Aprobación y alcance

Registro añadido el 19 de octubre de 2026, tras autorización explícita para implementar Fase 3. Las secciones anteriores conservan los resultados, recuentos y limitaciones históricos de Fases 1/2. Sus menciones a falta de autorización o compilación nativa corresponden a aquellas entregas, no al estado actual.

Audio nativo implementado para tres señales PCM precalculadas, no archivos de producción. Rodio 0.21.1 con `playback` y sin características predeterminadas, CPAL 0.16 transitivo y UUID; `src-tauri/Cargo.lock` generado. Sin decodificación/importación, SQLite ni persistencia durable. Fase 3 implementada con aceptación de hardware pendiente; Fase 4 sigue requiriendo autorización.

## Entorno actualizado

- Linux; Node 22.23.3 temporal mediante `npm exec --yes --package=node@22 --`, sin reemplazar Node 18 del sistema.
- Rust estable 1.99.1, Cargo, rustfmt y Clippy instalados temporalmente bajo `/tmp/opencode/cargo` y `/tmp/opencode/rustup`, sin cambios globales. Rust sigue ausente del PATH normal.
- Desarrollo ALSA 1.2.11 y GTK/WebKit presentes. La ausencia histórica de desarrollo librsvg no bloqueó el build nativo Linux actual; no se afirma que se instalara globalmente ni que todos los prerrequisitos de empaquetado estén completos.
- Las comprobaciones Rust usan `env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo` antes de `cargo`. Las rutas temporales dependen de que siga disponible ese entorno.

## Resultados ejecutados

Los comandos npm de esta tabla usan Node 22 temporal; los de Cargo, el entorno temporal anterior. Se registran las ejecuciones satisfactorias disponibles, sin presentar pruebas simuladas como hardware ni como IPC WebView real.

| Comando o comprobación                                                                    | Resultado de Fase 3                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `npm run typecheck`                                                                       | Superado.                                                        |
| `npm run lint`                                                                            | Superado sin advertencias.                                       |
| `npm run format:check`                                                                    | Superado en la comprobación frontend registrada.                 |
| `npm test`                                                                                | 78 pruebas en 7 archivos superadas.                              |
| `npm run build`                                                                           | Superado; frontend Vite.                                         |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`                         | Superado.                                                        |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Superado sin advertencias.                                       |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml`                                | 33 pruebas correctas y 1 de hardware ignorada.                   |
| `cargo build --locked --manifest-path src-tauri/Cargo.toml`                               | Superado; compilación nativa Linux, no instalador ni prueba GUI. |

La comprobación conjunta final `npm exec --yes --package=node@22 -- npm run check` pasó: tipos, lint, formato, 78 pruebas y build frontend. Después se repitieron formato Rust, Clippy, 33 pruebas correctas con 1 de hardware ignorada y compilación Linux, todos correctamente y con el archivo de bloqueo. Los comandos reproducibles completos están en [PHASE_3.md](PHASE_3.md).

La revisión documental posterior ejecutó Prettier `--write` y `--check` exclusivamente sobre README, ARCHITECTURE, AUDIO_ENGINE, ROADMAP, VERIFICATION, PHASE_3 y ADR-001/002/003, mediante Node 22 temporal. La comprobación de esos nueve documentos pasó. No modificó código ni repitió suites de producto, compilación o pruebas físicas.

## Cobertura automatizada

- Motor con driver simulado: arranque sin apertura/enumeración, voces independientes del mismo efecto, rechazo de la 17 sin robo, límite 1..64, paradas idempotentes, finalización y liberación de capacidad, ganancias finitas y semántica maestro/instancia/futuras voces.
- Dispositivos simulados: tokens renovados e IDs caducados rechazados, cierre antes de nueva apertura, restauración anterior incluso tras renovar lista, fallo de restauración, desconexión sin fallback y errores visibles. Fallo de inicio de una voz aislado, sin atribuirlo a archivos corruptos todavía inexistentes.
- Ciclo de vida y eventos: cientos de ciclos sin handles simulados restantes, instantáneas completas con revisión monotónica y contrato serializado.
- Worker: backpressure de cola acotada, consultas/acciones asíncronas, recolección en reposo, shutdown idempotente, STOP fuera de cola llena, cancelación antes de confirmar y rechazo de nuevas admisiones durante barrera.
- Render sin hardware: PCM compartido con cursores independientes, envolventes, mezclador común, fin de sinks, remuestreo estéreo, ganancias y protección numérica finita/acotada. Corte de salida cero mientras enumeración bloquea el worker; consulta/ganancia/selección no rearman; voces antiguas no reviven al rearmar con muestras retenidas.
- Frontend: los trece comandos, argumentos camelCase, respuestas/eventos `unknown` validados, errores y ausencia de Tauri; siete escuchas antes de consulta, polling de recuperación, revisiones/consultas/motores obsoletos y limpieza de listeners tardíos/StrictMode.
- Control/UI: sin voces optimistas, dos instancias de un efecto, ruta exclusiva sin bloquear STOP, un cambio en curso y última intención pendiente por control, maestro cero independiente, descarte de pendientes al parar/finalizar/desmontar/cambiar motor, borrador de límite por botón/Enter y valor confirmado separado, errores de salida no disponible, atajo desde modal sin restablecer demo y CRUD utilizable sin Tauri.

Los tests habituales **no abren una salida de audio física ni reproducen sonido en hardware**. La prueba ignorada `explicitly_selected_real_output_opens_without_playing` exige nombre exacto autorizado mediante `RADIOFX_TEST_OUTPUT_NAME`, abre/cierra una salida única sin reproducir señales y no se ejecutó.

## Handlers y ACL

La prueba `tauri_ipc_handlers_validate_camel_case_errors_snapshots_and_actual_acl` usa `tauri::test`, el contexto generado de producción, los handlers registrados y la autoridad ACL efectiva, con runtime y transporte simulados y un driver falso. Ejecuta los trece comandos, comprueba camelCase, serialización, errores de dominio e ID caducado tras refrescar dispositivos. Verifica autorización de `main`, escucha/liberación de eventos y denegación de comandos a otra ventana/origen remoto y de emisión frontend.

Esto aporta cobertura del despacho/ACL configurados y compilados; **no verifica IPC desde una WebView real, arranque GUI ni CSP en ejecución desktop**. No se ha abierto una salida real para esta prueba.

## Navegador

Chrome del sistema revisado a 1440x1000, 390x844 y 320x720. En el recorrido con IPC falso, desktop y 320 px mostraron dos voces simultáneas del mismo efecto, sin errores JavaScript ni desbordamiento horizontal. No fueron dispositivos móviles físicos ni un runtime Tauri. La respuesta falsa de IPC no demuestra reproducción nativa ni comportamiento del dispositivo real.

## Límites y aceptación

- Compilación nativa Linux superada: el bloqueo histórico por ausencia de Cargo ya no describe esta fase. No equivale a ejecución del binario, instaladores ni validación multiplataforma.
- Pendientes arranque GUI, puente WebView/IPC real, escucha en dispositivo expresamente elegido, USB/desconexión/cambio/restauración físicos, latencias, CPU/memoria medidas, accesibilidad integral y Windows/macOS.
- La protección suave `0.95 * tanh(x / 0.95)` tiene pruebas numéricas, pero colorea la mezcla y no es un limitador transparente. Calidad audible y clipping de salida real no medidos.
- La emergencia corta el render independientemente del worker; llamadas bloqueadas de driver pueden demorar ACK y shutdown. No retira buffers ya entregados al hardware ni acredita STOP p95 < 50 ms.
- Preferencia/configuración solo de sesión. Persistencia durable, resolución al reiniciar, archivos y SQLite pertenecen a Fase 4 aún no autorizada.

Checklist manual seguro y comandos reproducibles en [PHASE_3.md](PHASE_3.md). Completar o aceptar explícitamente estos pendientes de Fase 3 y **solicitar autorización antes de Fase 4**. No se inicia automáticamente la siguiente fase.

---

# Verificación de Fase 4

## Aprobación y alcance

Registro añadido el 19 de octubre de 2026 tras autorización explícita de Fase 4. Se conservan arriba, sin sustituir recuentos ni resultados, los registros históricos de Fases 1/2/3. Sus restricciones de alcance y puertas anteriores pertenecen a aquellas entregas. Fase 4 incorpora SQLite, biblioteca, importación, asignaciones y preferencias durables; **Fase 5 no está autorizada**.

La fase está implementada y automatizada con build nativo Linux válido. La repetición final de las cadenas frontend y Rust pasó con los resultados siguientes. La aceptación manual sigue pendiente del recorrido desktop real y del hardware; no se presentan esas pruebas como ejecutadas.

## Entorno y resultados

Se mantiene el entorno Linux anterior: Node 22.23.3 temporal y Rust 1.99.1 bajo `/tmp/opencode/cargo` y `/tmp/opencode/rustup`. Rust sigue fuera del PATH normal; no se afirma instalación global. Los comandos npm usan `npm exec --yes --package=node@22 --`; Cargo usa `env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo`.

| Comando o comprobación                                                                    | Resultado registrado de Fase 4                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                                                           | Superado: tipos estrictos, ESLint sin advertencias, Prettier, 142 pruebas frontend y build Vite.              |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`                         | Superado.                                                                                                     |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Superado sin advertencias.                                                                                    |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml`                                | 79 correctas, 1 hardware ignorada; incluye regresiones finales de pins/conversión.                            |
| `cargo build --locked --manifest-path src-tauri/Cargo.toml`                               | Superado, compilación nativa Linux; no prueba GUI ni instalador.                                              |
| Chrome con UI de producción y APIs falsas                                                 | 1440x1000, 390x844 y 320x720; sin errores JavaScript ni desbordamiento horizontal.                            |
| Repetición final de ambas cadenas                                                         | Superada: tipos, lint, formato, 142 pruebas frontend y build; formato Rust, Clippy, 79 pruebas y build Linux. |

Los totales son acumulados: Rust conserva 33 pruebas sin hardware de Fase 3 y añade 46, total 79 superadas, más la misma prueba física ignorada; frontend conserva 78 y añade 64, total 142. No sumar estos totales otra vez a los recuentos históricos. La revisión documental no requiere volver a ejecutar producto ni instalar dependencias.

La revisión documental ejecutó Prettier con el binario Node 22.23.3 ya existente, sin instalaciones. Se formatearon los documentos autorizados y solo el apéndice Fase 4 de este registro, conservando literalmente su prefijo histórico; `prettier --check` de README, ARCHITECTURE, AUDIO_ENGINE, ROADMAP, VERIFICATION, PHASE_4 y ADR-001/002/003/004 pasó. No se modificaron PHASE_2/3, código o datos de usuario ni se repitieron pruebas de producto por estos cambios de documentación.

## Cobertura de biblioteca

- SQLite real temporal: migración inicial 001/versionado `user_version=1`, reapertura/reinicio, FK/restricciones, referencias inválidas, esquema malformado y versión futura rechazados sin reset.
- Tablero: revisión SQL real, conflicto visible, operaciones atómicas y recarga consistente de tablas bajo transacción. Dos instancias reciben datos frescos; ajustes por UPDATE de campo preservan preferencias ajenas sin restaurar caches obsoletas. Esto no sincroniza el audio de dos procesos.
- Importación: cuatro fixtures codificados reales, límites de duración/canales/frecuencia/tamaño/PCM, selección máxima y catálogo; deduplicación, archivos ausentes/alterados, reparación del mismo hash con UUID nuevo y conservación de identidad, asignaciones, nombre/volumen.
- Archivos: originales intactos, symlinks, FIFO sin bloqueo y sustituciones de padres/entrada final con directorios fijados; creación exclusiva y rollback con limpieza solo de nuevas copias propias, sin borrar huérfanos ni datos ajenos. Fallos privados/transaccionales simulados, no prueba de disco lleno físico en producción.
- Aplicación integrada Rust: LibraryService con SQLite temporal y AudioService simulado, carga/reconciliación, registro tras importación sin autoplay/rearme, paradas y cambio de ruta independientes del I/O, dos disparos del mismo efecto y preferencias restauradas sin abrir salida.
- PCM/render offline: fuentes preparadas y mezcla consumidas en memoria sin dispositivo; presupuesto Arc/temporales, adaptación de salida compartida, pins activos, invalidación de cambios, protección numérica y límite de fuentes cuando el render no consume.
- Frontend: contratos/adaptadores de biblioteca, propiedades y límites validados, cola de controlador y estado solo tras ACK, importación cancelada/parcial/duplicada, reapertura con repositorio falso, conflictos y recarga sin sobrescribir. No hay pruebas frontend accediendo a SQLite real desde WebView.
- UI persistente: asignación al ID real, duración no editable, categoría/color/nombre, voces nativas por clic, disparos disponibles y parada por efecto durante I/O, STOP desde modal/importación, formularios y controles deshabilitados solo para edición.

Fixtures en `src-tauri/tests/fixtures/tone.wav`, `tone.mp3`, `tone.ogg`, `tone.flac`, generados con FFmpeg 6.1.1 según el test; los tests leen los bytes incluidos, no ejecutan FFmpeg. Formatos comprobados: WAV PCM, MP3, OGG Vorbis y FLAC con Symphonia 0.5.5. No se afirma soporte Opus ni de todas las variantes, ni detección universal de corrupción/truncamiento.

## Regresiones corregidas

La revisión detectó y corrigió problemas de seguridad de archivos, preferencias concurrentes, revisión basada en estado obsoleto y deduplicación/reparación. Las regresiones cubren descriptores fijados y nofollow/nonblock, lectura SQL fresca y patches por campo, conflicto sobre revisión SQL y recuperación con archivo nuevo sin sobrescritura.

La corrección final libera `conversion_inputs` obsoleto al registrar PCM cambiado o no disponible, retira conversiones ociosas y mantiene las activas contabilizadas. Sin ella una adaptación ociosa podía retener el PCM anterior y bloquear reemplazos/importaciones bajo presupuesto estrecho. La sincronización hace como máximo dos pases para soltar pins y revalidar; PCM realmente activo puede bloquear hasta fin/STOP y refresco posterior, sin reseleccionar salida. Las pruebas también rechazan reutilizar una adaptación del PCM anterior y acotan a 128 las fuentes pendientes si el render no avanza. No acreditan RSS ni latencias físicas.

## IPC y navegador

Diecisiete comandos registrados y permisos sincronizados con `build.rs`/capability: trece audio, `get_library_snapshot`, `save_board`, `set_library_columns`, `import_audio_files`, más escuchar/liberar eventos para `main`. No rutas IPC, filesystem genérico, emisión frontend ni permiso JS del selector. Las pruebas usan handlers y autoridad ACL reales con contexto generado, runtime/transporte simulados y servicios con SQLite temporal; **no una WebView real**. El selector nativo no se ejecutó.

Chrome recorrió la UI persistente de producción con APIs falsas a 1440x1000, 390x844 y 320x720, incluidos doble disparo, modal, importación y STOP, sin errores/desbordamiento. No se usaron dispositivos móviles físicos. Esto no valida diálogo nativo, audio, SQLite desde JavaScript ni E2E de la aplicación desktop.

## Límites y aceptación

- No se tocó el `app_data_dir` real ni se ejecutaron importaciones GUI sobre datos de usuario. Pruebas de backend usan directorios y SQLite temporales; no confundir reapertura de esos servicios con reinicio real desde WebView.
- Pendientes: arranque desktop, selector nativo y recorrido importar/asignar/cerrar/reabrir con persistencia desde GUI; usar perfil aislado, copia de seguridad y archivos de prueba, nunca una cabina en emisión.
- Persistir solo nombre no acredita identidad de hardware: coincidencia única sigue exigiendo confirmación, sin fallback ante ausencia/ambigüedad ni apertura al iniciar.
- Precarga completa acotada, no LRU/streaming: 128 MiB es presupuesto PCM con diagnósticos, temporales y reserva 32 MiB de adaptación, no límite de RSS. Conversión en frío y consumo total no medidos.
- Disponibilidad se revalida en inicio/refresco/importación, sin watcher continuo; una alteración externa puede no verse hasta refrescar. Copias viejas/huérfanos conservados consumen disco; no hay borrado de archivos de biblioteca.
- Raíz de aplicación privada es una hipótesis de seguridad. Los controles descriptor-relative de audios y flags SQLite no constituyen una afirmación universal contra TOCTOU ni contra un atacante con escritura local sobre la raíz.
- Pendientes físicos heredados: salida autorizada, USB/cambio/restauración/desconexión, calidad/coloración/clipping, CPU/memoria y latencias medidas. La prueba hardware sigue ignorada; p95 < 50 ms no medido.
- Windows, macOS, instaladores, accesibilidad integral e identidad/iconos de distribución no validados. Sin servicios de red de ejecución; las herramientas y dependencias de desarrollo pueden requerir red.

Checklist y comandos en [PHASE_4.md](PHASE_4.md). Completar o aceptar explícitamente pendientes manuales antes de cerrar la aceptación. **Solicitar autorización explícita antes de Fase 5**; no búsqueda, atajos configurables, loops, fade ni paquetes/importación-exportación de bancos en esta entrega.

---

# Verificación de Fase 5

## Aprobación y alcance

Registro añadido el 20 de octubre de 2026 tras autorización explícita de Fase 5. Los registros anteriores de Fases 1/2/3/4 conservan sus resultados y recuentos; sus puertas y restricciones de alcance son históricas. PHASE_2/3/4 y ADR-001 permanecen intactos. **Fase 5 implementó código de producto y pruebas**: atajos, loops/fades, búsqueda, traslado/copia y paquetes; no se presenta la entrega como exclusivamente documental. Fase 6 no autorizada ni iniciada.

## Entorno actual

- Linux; Node habitual 18 incompatible. Node 22.23.3 ya cacheado en `/home/ba0100062m/.npm/_npx/d0a7a686d16af82b/node_modules/node/bin/node`, usado anteponiendo su directorio al PATH por comando, sin reemplazar Node del sistema ni consultar npm por red.
- Rust/Cargo 1.99.1, rustfmt y Clippy disponibles en `/home/ba0100062m/.cargo/bin`. Cargo usa `env PATH="$HOME/.cargo/bin:$PATH"` y `--locked --offline` en tests/Clippy/build. No se afirma instalación global durante esta sesión ni se alteran archivos de inicio del shell.
- El tooling temporal Rust anterior de `/tmp/opencode` ya no está disponible. Las rutas de Fases 3/4 se conservan como historia, no como instrucciones actuales. No se requiere red en uso normal; intentos de desarrollo contra crates.io agotaron el tiempo de espera.
- Bloqueo inicial offline: `tempfile 3.27` no cacheado. Resuelto retirando solo esa dependencia de desarrollo y usando `test_support.rs` bajo `cfg(test)`: UUID, creación exclusiva, 0700 Unix, ocho intentos máximos, limpieza RAII de directorio propio y cinco pruebas. No crate falso ni cambios ajenos de versiones/checksums del lock. No hay nuevas dependencias runtime.
- La fuente de un crate ZIP tampoco estaba cacheada; se implementó y probó el codec mínimo ZIP Stored cerrado de `bank_archive.rs`, no compatibilidad ZIP general ni una dependencia ficticia.

## Resultados registrados

Estos resultados definitivos proceden de la ejecución final de ambas cadenas de validación de Fase 5, incluidas las correcciones Unicode. Todas las comprobaciones automáticas indicadas están superadas; GUI y hardware siguen fuera de esta evidencia.

| Comprobación                                                                                        | Resultado de Fase 5                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm run check` final con Node 22.23.3 cacheado                                                     | Superado: TypeScript, ESLint, Prettier, 233 pruebas en 15 archivos y build frontend. |
| Regresiones Unicode                                                                                 | 16 pruebas superadas e incluidas en el total final de 233.                           |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`                                   | Superado.                                                                            |
| `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Superado sin advertencias.                                                           |
| `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml`                                | 110 correctas y 1 de hardware ignorada.                                              |
| `cargo build --locked --offline --manifest-path src-tauri/Cargo.toml`                               | Superado en Linux; no instalador ni prueba GUI.                                      |
| Chrome con APIs falsas                                                                              | 1440x1000, 390x844 y 320x720; sin errores JavaScript/desbordamiento horizontal.      |

Totales acumulados, no sumables otra vez a los históricos: Rust conserva 79 y añade 31 (incluidas cinco del helper temporal), total 110, más la misma prueba de hardware ignorada. Frontend conserva las 142 anteriores con fixtures adaptadas a tablero v2 y añade 91, total 233 superadas en 15 archivos. No hay fallback de producción v1 para evitar adaptar fixtures. La ejecución final de formato Rust, Clippy all-targets, tests y build Linux también está superada con bloqueo de dependencias y modo offline donde corresponde.

Los primeros intentos bloqueados por herramientas/caché no cuentan como validaciones correctas. También hubo fallos iniciales de fixtures de trigger y presupuesto, corregidos conservando escenarios y aserciones significativos; las suites Rust posteriores pasaron completas offline. No se suprimen esos intentos ni se presentan los bloqueos resueltos como pendientes actuales.

La actualización de documentación ejecutó Prettier con Node 22.23.3 cacheado solo sobre README, ARCHITECTURE, AUDIO_ENGINE, ROADMAP, PHASE_5 y ADR-002/003/004; en VERIFICATION se formateó únicamente el apéndice Fase 5. `prettier --check` de los nueve documentos pasó. El prefijo histórico se conservó literalmente, con SHA-256 `4b6a2778ae50b0e5cdb3cf2f2310d06251fcc4aa2aaeeb575375f8b64fc3c348`. No se modificaron código, PHASE_2/3/4, ADR-001 ni datos de usuario por esta actualización, ni se repitieron pruebas de producto.

## Cobertura y regresiones

- Datos: tablero producción v2, demo v1 intacta, migración 002 sobre 001 inmutable, base v1 poblada, opciones/atajos durables y recarga. Apertura IMMEDIATE con validación de versión/tablas antes de DDL sobre base existente; versión futura preservada y esquema incompatible rechazado. La comparación de tablas no es auditoría universal de triggers/objetos SQL.
- Unicode: `codePointString` cuenta puntos de código, incluidos astrales, y `.regex(/\P{White_Space}/u)` alinea nombres de producción e IDs de atajos con la definición Unicode de texto no vacío/`trim` de Rust. A diferencia del criterio JavaScript `\S`, permite recargar identificadores importados válidos para Rust, incluido FEFF. Las 16 pruebas Unicode están superadas dentro del total final de 233. La política de controles de contenido no se relajó para resolverlo.
- Atajos: contratos/referencias/conflictos en Rust/TypeScript, máximo 512, ámbitos aplicación/banco, modificadores exactos y teclas reservadas. Listener raíz único con useEffectEvent y último ACK; ignorar IME, AltGraph, repeat, campos/editables/modales ordinarios y mantener emergencia reservada. No hotkeys del OS.
- Audio: cientos de vueltas sobre el mismo PCM compartido, fin de vuelta al desactivar loop, fade de entrada sin reinicio, envolventes coherentes por frame estéreo/extremos, fade explícito irreversible que progresa solo al consumir render y conserva cupo hasta fin. Repetir no extiende, stopped/finished correctos, STOP y rearme de ambas rutas sin revivir voces antiguas.
- Búsqueda/traslado: búsqueda sin acentos/mayúsculas en paleta/biblioteca y ámbitos; vista filtrada sin alterar orden/recuentos durables, DnD/flechas deshabilitados; copia con ID nuevo sin archivos/atajos duplicados y mover con aviso/eliminación atómica de bindings de disparo.
- Paquetes: roundtrip del subconjunto ZIP Stored, manifiesto/versión estrictos, CRC/hash/decoder real, límites, traversal/duplicados/caso/barras inversas/enlaces/tipos especiales, extras/ZIP64/cifrado/compresión/descriptores/comentarios/multidisco rechazados. No extracción de nombres de entrada a disco ni promesa de ZIP genérico.
- Preparación/commit: lease atómica de proceso y token único con caducidad perezosa de diez minutos; cancelar/Escape/X/desmontar, incluida respuesta tardía. Revisión y atomicidad de recursos/bancos/botones/opciones/atajos, IDs nuevos sin sobrescribir, deduplicación/defaults y reparación con UUID nuevo conservando archivo anterior. Opt-in respeta bindings deshabilitados y rechaza conflictos completos.
- Fallos: revisión obsoleta conserva token en Rust antes de aceptación, pero frontend cancela/recarga y exige preparar de nuevo; token aceptado se consume incluso ante fallo. Rollback limpia solo copias nuevas propias, error postcommit explícito y sin reimportación automática. Registro sin autoplay/rearme STOP.
- Presupuesto: PCM pendiente/pins activos y reutilización de Arc validado sin doble cómputo. Deduplicación con loop/conversión activa y presupuesto estrecho conserva reproducción y nuevos disparos. 128 MiB PCM con reserva 32 MiB de adaptación y límite de paquete 256 MiB no son límites RSS. Exportación mantiene recursos y ZIP codificado simultáneamente, cada conjunto acotado.
- Exportación: temporal exclusivo en directorio fijado, bytes sincronizados, publicación hardlink sin reemplazo y rechazo de destino existente aunque el selector permita confirmarlo. Sin `exists`/rename ni fallback inseguro; filesystem sin hardlinks produce error visible.

## IPC y navegador

Veinticuatro comandos de aplicación más escuchar/liberar eventos en `main`: dieciséis de audio y ocho de biblioteca/paquetes. Nuevos: `play_effect_with_options`, `set_playback_loop`, `fade_out_playback`, `prepare_bank_import`, `commit_bank_import`, `cancel_bank_import`, `export_sound_banks`. Las siete notificaciones conservan instantáneas completas, sin frames IPC. Selectores desde Rust, sin rutas/bytes de paquetes en JavaScript ni permisos generales filesystem/shell, emisión frontend o hotkeys OS.

Las pruebas handlers/ACL usan contexto de producción y autoridad efectivos con runtime/transporte simulados. Backend utiliza SQLite/archivos temporales reales y fixtures, audio falso o render en memoria; no hardware ni WebView real. No se abrió GUI Tauri, selector nativo ni base de datos real del usuario.

La revisión de implementación comunicó recorrido Chrome con APIs falsas en 1440x1000, 390x844 y 320x720: captura de teclas, búsqueda, paquetes/vista previa, modales, loop/fade y STOP sin errores/desbordamiento. No son móviles físicos ni pruebas de IPC desktop. No se presupone que capturas/scripts temporales sigan disponibles ni se añadió biblioteca permanente de Playwright/capturas al proyecto.

## Aceptación y puerta

Pendientes manuales: respaldar con todas las instancias cerradas, especialmente clientes v1; migrar copia poblada en perfil aislado; verificar persistencia de opciones/atajos, selectores/IPC reales, emergencia en modales, búsqueda/traslado y conflictos; exportación existente rechazada, vista previa/cancelación/nueva preparación y atomicidad ante paquetes inválidos sin tocar originales. Checklist seguro y comandos actuales en [PHASE_5.md](PHASE_5.md).

Pendientes físicos heredados y ampliados: escuchar loops/fades con nivel bajo, coherencia de canales, USB/cambio/desconexión/restauración, calidad/transitorios/clipping real, mediciones CPU/RSS/latencias. No crossfade ni garantía gapless; metas p95 < 50 ms no medidas. Hardware continúa ignorado, no ejecutado. Windows/macOS, instaladores, accesibilidad integral e identidad/iconos no validados.

La implementación Fase 5 queda entregada con resultados automáticos registrados, sin confundir build Linux con E2E desktop. Completar o aceptar explícitamente los pendientes manuales y **solicitar autorización antes de Fase 6**. No continuar automáticamente con benchmarks físicos, distribución ni instaladores.

---

# Verificación de Fase 6

## Autorización y alcance

Fase 6 autorizada por el usuario. Se añade este registro sin modificar el historial de Fases 1 a 5 ni PHASE_2/3/4/5; las puertas anteriores son históricas. Herramientas de calidad, benchmark, CI y paquetes ya implementadas; esta entrega solo actualiza documentación y conserva el JSON offline. No se declara Fase 6 cerrada ni publicación autorizada.

## Evidencia registrada

- Linux Mint 22.2 x86_64, kernel 6.14.0-35-generic, glibc 2.39, Intel Core Ultra 7 155H, 22 procesadores lógicos. Node cacheado 22.23.3, npm 9.2.0, Rust/Cargo 1.99.1 y Tauri CLI 2.12.3. Rust estable ya disponible en `$HOME/.cargo/bin`, sin instalación global en esta sesión.
- La cadena principal inicial `npm run check:all` pasó con 254 frontend. Tras diez regresiones de metadatos, la revisión independiente ejecutó 264 pruebas frontend en 16 archivos correctamente. Los checks normales posteriores de tipos, lint y formato están superados; no atribuir las 264 a aquella cadena inicial.
- Rust normal: 116 correctas y 2 ignoradas, apertura hardware y benchmark opt-in. rustfmt y Clippy `--all-targets --locked --offline -- -D warnings` superados. Los recuentos son acumulados, no se suman de nuevo a los históricos.
- `npm run bench:audio -- --report /tmp/opencode/radiofx-offline-benchmark-final.json` superado en release, sin salida CPAL. También se verificó la ejecución sin informe tras corregir el entorno vacío. Los intentos iniciales de estrés y timeout a 240 s no cuentan como éxitos; la repetición con margen de 600 s pasó.
- JSON conservado en `docs/validation/offline-benchmark-linux-x86_64.json`, timestamp Unix original 1792544451910. Render p95 para 1/16/64 voces: 68.788/528.256/2080.521 µs por bloque de 512 frames a 48 kHz estéreo. ACK play p95 296.671 µs, ACK STOP 9953.546 µs y corte hasta siguiente bloque 10.151 µs, en ensayos separados; no latencias físicas.
- Estrés offline: 500 ciclos de 16 voces, 250 finales naturales y 250 paradas de voces aún activas tras 32/128 frames; recursos propios comparados con línea base y a cero al cerrar. RSS 17452 KiB en calentamiento/final, solo observaciones, no prueba de estabilidad. Parámetros, CPU y límites completos en PHASE_6.
- `npm run bundle:linux` pasó: frontend y Tauri release con LTO, `--ci --no-sign --bundles deb -- --locked --offline`. DEB de 3833166 bytes, SHA-256 `2f49f6920e0aff5f78d14561ed408767c7d426686dd436723f3b2226aba02ea3`, solo prueba local sin firma.
- `dpkg-deb`, extracción sin root, `desktop-file-validate`, `ldd` sin faltantes e inspección ELF PIE/RELRO/stack RW superados en el host local. Metadatos finales incluyen ALSA y baseline glibc >= 2.39. No instalación, actualización/desinstalación ni auditoría completa acreditadas.
- Manifiesto `src-tauri/target/release/artifacts.json` generado exclusivamente, con hashes/tamaños e inventario de fuentes tomado después del build. No prueba procedencia/frescura del binario, firma ni reproducibilidad bit a bit.
- Arranque y reapertura del proceso release con perfil XDG aislado en `/tmp/opencode/radiofx-desktop-esdCMt/`, ventana RadioFX Studio 1100x760 observada con xwininfo. Reapertura sin override DMABUF. SQLite leída en modo solo lectura: versión 2, Principal, revisión 0, maestro 0.7, límite 16, preferencia nula.
- Cierre por SIGTERM del timeout, no cierre normal validado. Sin captura visual válida ni recorrido interactivo WebView/selector/IPC/CSP acreditado. Enumeración produjo avisos ALSA pulse/jack/oss y puede sondear hardware; no se seleccionó stream activo ni se reprodujo audio. Perfil normal del usuario no utilizado.
- Configuraciones NSIS/app/DMG y workflows quality/distribution preparados, no ejecutados remotamente ni validados en Windows/macOS. Icono propio provisional; identificador y versión existentes conservados.

## Límites y decisión

El benchmark software incluye comprobaciones numéricas y no demuestra porcentaje CPU, estabilidad RSS, calidad audible, clipping físico, USB ni p95 end-to-end < 50 ms. Protocolo y fichas pendientes en [HARDWARE_TESTS.md](HARDWARE_TESTS.md); comandos, metodología y evidencia completa en [PHASE_6.md](PHASE_6.md).

Publicación bloqueada por licencia/titular/publisher e identidad final, firmas/notarización, plataformas, instalación y aceptación desktop/hardware. El preflight devuelve `publicationAllowed: false`; SHA-256 no es autenticidad. [RELEASE.md](RELEASE.md) registra el DEB local y sus límites. Fase 6 es la última prevista: falta decisión legal y aceptación física del titular, no una Fase 7 ni publicación automática.

## Comprobación documental

Se ejecutó Prettier con Node 22.23.3 cacheado solo sobre los documentos actuales autorizados y el JSON; VERIFICATION se editó exclusivamente por apéndice, sin reformatear su historia. `prettier --check` pasó en README, ARCHITECTURE, AUDIO_ENGINE, ROADMAP, VERIFICATION, PHASE_6, RELEASE, HARDWARE_TESTS y el JSON de validación. La comparación estructural JSON confirmó igualdad con el informe original; los hashes de PHASE_2/3/4/5 no cambiaron. El prefijo histórico íntegro de VERIFICATION conserva SHA-256 `8b7e9e5041d47a61153b4bd3bcc2593f572edd42a0a2c72d2356a06e9c09049f`.

No se modificaron código, package/lock, scripts, CI, configuración Tauri, iconos ni datos de usuario en esta entrega documental. No se repitieron suites de producto, benchmarks, bundles ni pruebas físicas por estos cambios; los resultados anteriores se registran como evidencia comunicada de la implementación y revisión, no como nuevas ejecuciones documentales.

---

# Corrección: reinicio al repetir un efecto

## Requisito y alcance

Corrección explícita solicitada por el usuario: repetir un botón debe reiniciar el sonido desde cero sin acumular copias; efectos distintos siguen mezclándose. Los registros anteriores, PHASE_2/3/4/5/6 e informes de benchmark se conservan como historia, no como descripción de este nuevo despacho. No se abre otra fase ni se autoriza publicación.

`restart_effect({ effectId, options: PlaybackOptions }) -> playback_id` es una operación serializada del worker: valida objetivo, opciones, volumen por defecto, salida, PCM disponible y cupo antes de cortar. Si rechaza, conserva las voces anteriores. Al aceptar corta todas las del recurso, incluidas loop/fade, e inicia una con ID, cursor y envolvente nuevos desde frame cero, volumen por defecto vigente y opciones recibidas. Reutiliza cupo propio con el límite lleno sin robar voces ajenas. Un fallo de inicio del driver posterior al corte deja las anteriores retiradas y el error visible, sin cortar otros efectos; no promete rollback ni retirada de buffers ya entregados al SO/hardware.

`NativeAudioController.play` usa opciones por defecto sin loop/fades y `playWithOptions` las explícitas; ambos invocan `api.restartEffect`. Paleta, atajos y diagnóstico comparten la ruta. El alcance es `effect_id` global dentro del motor del proceso, incluso entre botones de bancos diferentes. No cambia el esquema SQLite ni las opciones por asignación. `play_effect` y `play_effect_with_options` conservan superposición explícita del mismo recurso para núcleo, benchmarks y API de bajo nivel, no como ruta de botones normales. La demo sigue siendo visual y no demuestra comportamiento nativo.

## Validación final

La comprobación integral final y el empaquetado se ejecutaron con Node 22.23.3 y Rust 1.99.1, con la corrección incorporada.

| Comprobación                                                                            | Resultado final de la corrección                                                          |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run check:all`                                                                     | Superado: tipos, lint, formato, pruebas y build frontend; rustfmt, Clippy y pruebas Rust. |
| Pruebas frontend                                                                        | 266 superadas en 16 archivos.                                                             |
| Pruebas Rust                                                                            | 122 correctas y 2 ignoradas: hardware y benchmark opt-in.                                 |
| rustfmt y Clippy all-targets                                                            | Superados, sin advertencias.                                                              |
| `npm run bundle:linux`                                                                  | Superado: release Linux y DEB reconstruidos con la corrección.                            |
| `npm run release:artifacts -- --output src-tauri/target/release/artifacts-restart.json` | Manifiesto nuevo generado sin sobrescribir `artifacts.json`.                              |

Los totales son acumulados, no se suman otra vez a los históricos. El DEB vigente es `src-tauri/target/release/bundle/deb/RadioFX Studio_0.1.0_amd64.deb`, SHA-256 `872e775ddc5c42ebfb618c2d7b2bb74a21229c203e0daaf11407c1e5ab25a78c`, con manifiesto `src-tauri/target/release/artifacts-restart.json`. Conserva versión `0.1.0`, sin firma y solo de prueba; no se instaló. Una instalación anterior no se actualiza automáticamente: para incorporar la corrección hay que usar la aplicación actualizada. El hash anterior y `artifacts.json` quedan como historial, no como referencia del paquete reconstruido; detalle en [RELEASE.md](RELEASE.md#artefacto-vigente-con-la-corrección). No se realizaron pruebas GUI, auditivas, hardware ni nuevas ejecuciones de benchmark para esta corrección.

## Regresiones cubiertas

- 500 reinicios conservan una sola voz objetivo, IDs nuevos y otro efecto activo; el primer reinicio colapsa todas las voces del objetivo creadas mediante superposición explícita de la API de bajo nivel.
- Límite lleno de 16: reutilización del cupo objetivo sin otro slot; otro efecto sin cupo se rechaza y no se roba ninguna voz ajena.
- Objetivo/opciones/volumen inválidos, salida no preparada y PCM no disponible conservan voces previas; fallo del driver después del corte retira solo las del objetivo y deja error visible.
- Reinicio de loop/fade con volumen por defecto vigente y opciones nuevas, sin heredar ganancias de instancia, cursor o salida en curso; eventos ordenados e instantáneas reconciliables.
- Reinicios concurrentes serializados y carreras con STOP ALL: cancelación/barrera, corte mantenido y rearme solo por una nueva admisión aceptada tras la barrera, sin reabrir fuentes retiradas.
- Fuente real consumida en memoria: PCM y envolvente desde frame cero, compuerta antigua cerrada incluso con muestras retenidas; no es escucha ni dispositivo físico.
- Adaptador/controlador frontend: argumentos y respuestas validados, rutas `play`/`playWithOptions` a `restartEffect`, IDs confirmados y errores sin inventar voces optimistas.
- IPC: comando registrado, camelCase, validaciones y autoridad ACL efectiva de producción con runtime/transporte falsos. Registro/capability y comprobaciones actuales cuentan 25 comandos: 17 de audio y 8 de biblioteca/paquetes; no equivale a IPC desde WebView real.

## Revisión documental

Solo se actualizan README, ARCHITECTURE, AUDIO_ENGINE, ADR-002, ADR-003, este apéndice y la referencia al artefacto vigente en RELEASE. Se conservan los históricos y los informes de benchmark, sin cambios documentales en código, scripts, dependencias, AGENTS o artefactos.

Formato documental comprobado con Prettier y Node 22.23.3 ya cacheado, sin instalaciones, conservando el prefijo histórico de VERIFICATION sin reformatear. Esta revisión documental registra la validación final y el paquete reconstruido, sin repetir suites de producto ni builds ni atribuirles aceptación física.
