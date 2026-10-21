# Arquitectura

## Estado actual

Aplicación local Tauri 2 con React 19, TypeScript 6 estricto, Vite 8, Tailwind CSS 4, Zod 4 y Zustand 5 para la demo. Sin API REST, backend remoto, cuentas ni telemetría obligatoria. Fase 6 autorizada y parcialmente validada en Linux; publicación bloqueada y aceptación desktop/manual y hardware pendientes.

Los registros históricos se conservan en [VERIFICATION.md](VERIFICATION.md) y PHASE_2/3/4/5. Sus bloqueos no describen el presente: hay Cargo.lock, compilación nativa Linux y arranque/reapertura del proceso GUI en perfil aislado. Rust/Cargo 1.99.1 están en `$HOME/.cargo/bin`; las herramientas temporales anteriores de `/tmp/opencode` ya no están disponibles. Esto no acredita interacción WebView completa ni audio físico.

## Módulos implementados

| Ubicación                                                             | Responsabilidad                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/app/App.tsx`, `PersistentStudio.tsx`                             | Selecciona producción persistente en Tauri o demo explícita en navegador; composición de vistas.      |
| `src/features/soundboard/`                                            | Vista compartida, hook persistente y store/hook separados para la demo en memoria.                    |
| `src/features/sound-banks/`                                           | Modelos Zod y repositorio síncrono en memoria; CRUD y orden de bancos.                                |
| `src/features/sound-library/`                                         | Controlador asíncrono de biblioteca, importación, resultados parciales y editor de asignaciones.      |
| `src/features/soundboard/usePersistentSoundboard.ts`                  | Coordina formularios, biblioteca confirmada y un controlador nativo raíz; sin duplicar el store demo. |
| `src/features/audio-controls/AudioControls.tsx`                       | Volumen visual y restablecimiento de la demo.                                                         |
| `src/features/audio-controls/NativeAudioControls.tsx`                 | Dispositivos, señales Rust, voces, ganancias y límite confirmado.                                     |
| `src/features/audio-controls/native-controller.ts`                    | Espejo de instantáneas, reconciliación, operaciones de ruta y coalescencia de controles.              |
| `src/features/audio-controls/useNativeAudio.ts`                       | Integración React y único listener raíz de teclado, emergencia y despacho con useEffectEvent.         |
| `src/features/settings/`                                              | Configuración visual y diagnóstico nativo.                                                            |
| `src/components/ui/Modal.tsx`                                         | Diálogo, ciclo de foco, Escape y restitución de foco.                                                 |
| `src/shared/contracts/audio.ts`                                       | Esquemas Zod estrictos de estado, dispositivos, efectos, voces, errores, selección y eventos.         |
| `src/shared/adapters/audio.ts`, `library.ts`                          | Diecisiete comandos de audio y ocho de biblioteca/paquetes, Zod y siete suscripciones de audio.       |
| `src/shared/contracts/library.ts`                                     | Contratos Zod de tablero, configuración, efectos e importación, sin rutas de archivos.                |
| `src/styles/global.css`                                               | Estilos locales y adaptación responsive.                                                              |
| `src-tauri/src/domain/audio.rs`                                       | Tipos e invariantes, ganancias finitas y errores serializables mediante Serde; sin Tauri ni SQLite.   |
| `src-tauri/src/domain/library.rs`                                     | Instantáneas serializables y PCM preparado compartido mediante Arc.                                   |
| `src-tauri/src/application/library.rs`                                | Inicialización y sincronización del catálogo; I/O en blocking pool separado del worker de audio.      |
| `src-tauri/src/infrastructure/library.rs`, `library/tests.rs`         | SQLite, revisión del tablero, patches de preferencias, importación y presupuesto de precarga.         |
| `src-tauri/src/infrastructure/decoder.rs`, `filesystem.rs`            | Symphonia acotado y archivos regulares con resolución relativa a descriptores sin seguir enlaces.     |
| `src-tauri/migrations/001_library.sql`, `002_professional.sql`        | Migraciones versionadas; 001 inmutable y 002 para opciones de botón y atajos.                         |
| `src-tauri/src/application/engine.rs`                                 | Reglas, estado autoritativo y puerto `AudioDriver`; selección, recuperación, voces y publicación.     |
| `src-tauri/src/application/worker.rs`                                 | Propietario único del motor/driver, cola acotada, respuestas asíncronas y barrera de emergencia.      |
| `src-tauri/src/infrastructure/audio.rs`                               | Driver Rodio/CPAL, PCM precalculado, mezcla, ganancias y compuertas atómicas.                         |
| `src-tauri/src/commands/`                                             | Adaptadores Tauri y pruebas de handlers/ACL con transporte simulado.                                  |
| `src-tauri/src/lib.rs`, `build.rs`, `capabilities/default.json`       | Composición, registro de comandos, ACL generada y permisos mínimos.                                   |
| `tests/`, `application/engine/tests.rs` y tests internos Rust         | Contratos, lógica, UI, worker, render sin hardware e IPC simulado.                                    |
| `src/features/keyboard-shortcuts/`, `src/shared/search.ts`            | Contratos/despacho/editor de atajos y búsqueda local sin acentos.                                     |
| `src/features/sound-banks/BankPackages.tsx`                           | Vista previa, opt-in de atajos, cancelación y exportación de bancos.                                  |
| `src-tauri/src/infrastructure/bank_archive.rs`, `library/packages.rs` | Codec ZIP Stored cerrado, validación, preparación y commit/exportación.                               |
| `src-tauri/src/test_support.rs`                                       | Directorios temporales privados y exclusivos, solo para pruebas.                                      |

El dominio no depende de Tauri, React o SQLite. Los tipos de dominio actuales derivan `Serialize` y se usan directamente en el borde: no hay una capa adicional de DTOs separada como en el diseño inicial. Infraestructura implementa el puerto de aplicación. No se crean carpetas vacías ni abstracciones de persistencia sin implementación.

## Flujo nativo

```text
Vista React -> controlador -> adaptador con validación Zod
  -> invoke<unknown> -> comando Tauri -> AudioService
  -> cola normal acotada -> worker propietario -> Engine -> AudioDriver
  -> NativeDriver Rodio/CPAL -> mezcla común -> único stream

Engine -> instantánea completa con engine_id/revision
  -> evento dirigido a main o respuesta a consulta
  -> validación Zod -> reconciliación -> vista React

STOP ALL -> AtomicBool de corte -> ProtectedSource devuelve cero
  -> worker detiene voces/cancela pendientes -> confirmación
```

El driver se construye dentro del worker: el stream no debe transferirse entre hilos ni requerir `Send` de forma artificial. El arranque precalcula tres señales e inicia la biblioteca fuera del worker, pero no enumera ni abre hardware en Rust. El controlador frontend instala las escuchas, consulta el estado y solicita enumeración, nunca selección automática. Cada proceso tiene su propio motor y como máximo un stream: compartir SQLite no sincroniza audio entre procesos.

La cola normal admite 64 solicitudes pendientes y devuelve `request_queue_full` si se llena. El worker consulta finalizaciones/fallos cada 10 ms y antes de despachar operaciones; este intervalo no es una garantía de tiempo real. No se ejecutan disco, decodificación, SQLite, logging síncrono ni UI en el callback de audio. La señal de fallo del stream, el maestro y el corte usan atómicos; las tareas de driver y emisión ocurren fuera del callback.

## Emergencia

`stop_all` evita la cola y activa directamente el corte de la fuente protegida final. El render entrega cero sin consumir el mezclador mientras está activo, incluso si el worker está bloqueado enumerando dispositivos. El worker detiene las voces, cancela órdenes normales pendientes, incluidas consultas y ganancias (`request_cancelled`), y confirma después de vaciar la cola. Nuevas admisiones normales durante la barrera fallan con `stop_in_progress`; paradas concurrentes comparten confirmación.

Las voces retiradas tienen una compuerta `live` irreversible situada después del remuestreo: no reaparecen al rearmar. Solo un nuevo disparo aceptado tras la barrera desactiva el corte. Consultas, ganancias o selección de salida no desmutean. La UI descarta intenciones de ganancia/límite antiguas aún no enviadas, pero no puede cancelar IPC ya enviado.

Una llamada bloqueada del driver puede retrasar el ACK y el cierre del worker, no el corte atómico de muestras futuras. Los buffers entregados al sistema/hardware quedan fuera de ese control. No hay promesa de silencio físico inmediato ni medición de latencia.

## Estado y reconciliación

Rust publica `AudioEngineStatus`: `engine_id` UUID, `revision`, `state`, `selected_device`, `active_playbacks`, `master_volume`, `max_concurrent_playbacks`, `last_error` y `effects`. Los estados son `not_initialized`, `ready` y `device_error`. En una instalación nueva el límite es 16, maestro 0.7 y ganancias por defecto 0.5; después se restauran valores durables, nunca voces ni una salida abierta.

Los siete eventos contienen la instantánea completa, no deltas. Se instalan antes de la consulta inicial. El controlador consulta también cada 1500 ms y tras operaciones para recuperar eventos perdidos. Descarta revisiones antiguas; un cambio de `engine_id` requiere consulta autoritativa, no basta un evento. Secuencias, épocas y motores retirados impiden que consultas tardías restauren estado anterior. La generación de montaje, cancelación de timer y liberación de listeners tardíos protegen StrictMode y desmontaje.

React no crea voces ni ganancias confirmadas optimistas. La selección de lista, errores, formularios y borrador de límite son UI; el límite confirmado sigue siendo el de Rust. Ganancias/límite conservan una solicitud en curso y solo la última pendiente por control, sin bloquear otras ganancias ni paradas. Las intenciones de voces finalizadas o de un motor anterior se descartan.

## Separación mock

`BankRepository.load/save` es síncrono y en memoria. Valida y copia una instantánea versión 1 con bancos, selección e identidades coherentes; guardar antes de publicar evita cambios parciales en la demo, no equivale a una transacción SQLite. Volumen visual, columnas y estados demo están fuera de esa instantánea.

En la demo, `SoundButton.id` identifica la asignación; `effectId` mock puede ser nulo y no pertenece al catálogo nativo. Duración y estados disponible/reproduciendo/pausado/error son visuales. El contador cuenta botones demo, no voces. **Restablecer demo** y volumen del pie no invocan Rust. Estos datos en memoria no se migran ni se usan como fallback ante un fallo durable.

## Biblioteca persistente de Fase 4

`isTauri()` selecciona `PersistentStudio`; el navegador conserva la demo explícita. `LibraryController` serializa operaciones asíncronas, valida resultados con Zod y publica solo ACKs. Un conflicto invalida intenciones encoladas y recarga el estado confirmado sin reenviar ni sobrescribir la edición ajena. `usePersistentSoundboard` coordina formularios y ciclo de vida; `PersistentStudio` compone vistas. El audio conserva su controlador, coalescencia de escalares y Ctrl+Shift+Space en la raíz.

Los botones persistentes asignan un `effectId` real distinto de su `id`; duración de solo lectura obtenida del recurso, nombre/categoría/color personalizables y recuentos de voces nativas. Cada clic solicita reiniciar ese efecto desde cero, no un toggle ni otra copia superpuesta. Durante I/O solo se bloquea la edición: recursos ya confirmados y disponibles, parada por efecto y STOP siguen utilizables. Una carga inicial rechaza los disparos, incluido `restart_effect`, inmediatamente con `library_loading`, nunca deja un disparo diferido. Registrar recursos tras importar no reproduce ni rearma STOP.

```text
Biblioteca React -> adaptador Zod -> comandos de biblioteca
  -> LibraryService -> spawn_blocking -> LibraryStore
  -> SQLite + archivos gestionados + decoder -> PCM Arc
  -> registro en AudioService -> worker -> motor/driver

Selector Rust -> archivos elegidos -> copias privadas -> commit SQLite
  -> registro -> resultado parcial + instantánea confirmada
```

`rusqlite 0.40.2` bundled abre `app_data_dir/library.sqlite3`. La migración 001 permanece inmutable; 002 lleva a `user_version=2`, añade opciones de reproducción por asignación y `keyboard_shortcuts`. Una transacción IMMEDIATE comprueba versión y estructura de tablas antes de aplicar DDL sobre una base existente; vuelve a comparar tablas y comprueba integridad/referencias antes del commit. Es una comparación del esquema de tablas, no una auditoría universal de triggers y objetos SQL. Una versión futura se rechaza sin migrarla ni resetearla. Una base nueva contiene Principal vacío. No existía persistencia pre-Fase 4.

El esquema contiene `sound_effects`, `sound_banks`, `bank_effects`, `categories`, `app_settings`, `diagnostic_volumes` y `keyboard_shortcuts`. Conserva metadatos/ruta relativa/hash, posiciones, asignaciones con loop/fades, atajos, banco activo, columnas, maestro, límite, nombre preferido y ganancias predeterminadas; no bytes PCM ni voces. El tablero de producción es versión 2; la demo sigue en versión 1, sin fallback de producción. Nombres: banco 60, categoría 80 y botón 100 puntos de código Unicode, alineados entre Rust y TypeScript.

Solo el tablero usa `board_revision` y `expectedRevision`. La escritura verifica la revisión SQL real; las lecturas recargan todas las tablas en una transacción consistente. Preferencias usan UPDATE del campo solicitado, no una instantánea obsoleta de todos los campos: preservan cambios de otro proceso. Dos instancias pueden detectar conflictos y recargar datos frescos; esto no implica sincronización global de ganancias/dispositivo/voces de sus motores independientes.

Maestro, límite y valores por defecto se aplican primero al motor y después se guardan fuera del worker. Si falla persistir, `persistence_partial_failure` informa que el audio ya cambió; no simula rollback. Los volúmenes de instancia no son durables. La salida solo guarda su nombre; la UI informa coincidencia única, ausente o ambigua y exige confirmar incluso una coincidencia única. Ningún arranque fuerza salida.

Importación mediante `tauri-plugin-dialog 2.8.3` desde Rust, sin rutas IPC ni permiso genérico de filesystem. Copias exclusivas `audio/<uuid>.bin`, rutas relativas y SHA-256 (`sha2 0.11.1`) deduplican bytes; los originales no se modifican ni eliminan. Reimportar bytes sanos repara una copia gestionada ausente/alterada con otro UUID de archivo, preservando efecto, asignaciones, nombre y volumen y devolviendo `duplicate: true`. La entrada vieja no se sobrescribe ni elimina. Un fallo revierte SQL y limpia solo archivos nuevos propios aún no confirmados; huérfanos inesperados se conservan.

La apertura de audios usa `cap-std/cap-fs-ext 4.0.3`, padres fijados con descriptores sin seguir enlaces, apertura final nofollow/nonblock y comprobación de archivo regular; creación gestionada exclusiva. No hay `unsafe` propio. SQLite se abre separadamente con NOFOLLOW y comprobaciones de enlaces/sidecars: se presupone raíz de aplicación privada, no inmunidad universal a TOCTOU o a un atacante con escritura sobre esa raíz.

Extensión, firma y Symphonia 0.5.5 verifican WAV PCM, MP3, OGG Vorbis y FLAC. Precarga completa de recursos disponibles con límites de archivo/PCM/duración/canales/frecuencia y presupuesto compartido; no LRU ni streaming. Disco/hash se revalidan al iniciar, refrescar e importar, no con watcher continuo. La liberación final de pins obsoletos, reserva de conversión y reintento acotado están detallados en [AUDIO_ENGINE.md](AUDIO_ENGINE.md).

## Funciones profesionales de Fase 5

Las opciones `playback` por botón son `looped`, `fadeInMs` y `fadeOutMs`. El motor conserva la autoridad de loop y estado `playing`/`fading_out` por instancia. El cursor recorre PCM adaptado compartido, sin copiar cada vuelta ni construir buffers infinitos. Las envolventes avanzan al consumir frames de salida, no por un plazo de reloj de pared. No hay crossfade ni garantía auditiva gapless. Paradas y fallos/cambios de dispositivo siguen cortando sin fade. Véase [AUDIO_ENGINE.md](AUDIO_ENGINE.md).

Los atajos contienen identidad, ámbito `application`/`bank`, `scopeBankId`, chord físico de `code` y modificadores exactos, acción y `enabled`. Rust y TypeScript validan referencias, máximo 512 y colisiones de combinaciones habilitadas: aplicación colisiona con cualquier ámbito; dos bancos distintos pueden reutilizar combinación. Un listener raíz con `useEffectEvent` lee el último ACK. Los atajos ordinarios ignoran repetición, IME, AltGraph, campos editables y modales; la emergencia reservada se procesa antes y funciona dentro de ellos. No hay plugin ni hotkeys del sistema operativo.

La búsqueda local sin acentos/mayúsculas filtra nombres, categorías, bancos y recursos, sin guardar filtros ni alterar posiciones/recuentos durables. Desactiva DnD/flechas en filtro o multibanco. Copiar crea ID de asignación nuevo sin clonar archivos ni atajos; mover mantiene el ID y elimina, con aviso explícito y en el mismo guardado, los atajos que disparaban esa asignación.

Los paquetes pasan por selector Rust, validación completa y vista previa con token. Una lease atómica de proceso permite solo una preparación pendiente; caduca perezosamente a diez minutos al acceder a biblioteca, sin temporizador autónomo. PCM pendiente y pins activos cuentan en el presupuesto; compartir el mismo Arc no duplica su contabilidad. Cancelar, Escape, X y desmontaje invalidan también respuestas tardías. El commit compara revisión y confirma todos los recursos/bancos/botones/opciones/atajos en una transacción, con IDs nuevos y sin sobrescribir bancos. Deduplica por hash conservando defaults locales. El backend retiene el token ante conflicto previo a aceptarlo, pero el frontend lo cancela y exige preparar de nuevo. Un token aceptado se consume incluso si falla; un error posterior al commit exige recarga, nunca reimportación automática. Registrar recursos no reproduce ni rearma STOP.

La exportación no incluye SQLite, rutas, salida, maestro ni diagnósticos. El codec manual `bank_archive.rs` implementa un subconjunto mínimo ZIP Stored, no ZIP genérico; no se añadió dependencia runtime. Límites, manifiesto, rechazo de entradas peligrosas y publicación con hardlink sin reemplazo se documentan en [ADR-004](DECISIONS/ADR-004-local-data.md) y [PHASE_5.md](PHASE_5.md).

## Seguridad y verificación

`build.rs` registra veinticinco comandos con `AppManifest::commands`: diecisiete de audio y ocho de biblioteca/paquetes, incluido ahora `restart_effect`. Fase 5 añade `play_effect_with_options`, `set_playback_loop`, `fade_out_playback`, `prepare_bank_import`, `commit_bank_import`, `cancel_bank_import` y `export_sound_banks`. La capability concede únicamente sus permisos y `core:event:allow-listen/unlisten` a `main`. No concede emisión frontend, acceso general a archivos, comandos directos del plugin de diálogo o shell. El backend emite a `main`; CSP de producción local y `devCsp` limitada al desarrollo localhost, sin opener.

Las pruebas con `tauri::test` usan contexto de producción generado, handlers y autoridad ACL efectivos con runtime/transporte simulados: verifican argumentos camelCase, errores, tokens caducados, permisos de `main`, escucha/liberación y denegación a otra ventana, origen remoto y emisión frontend. No acreditan el intercambio desde una WebView real ni la aplicación efectiva de CSP en ejecución GUI.

Los resultados históricos de Fase 5 permanecen en [VERIFICATION.md](VERIFICATION.md). En Fase 6 se registran 264 pruebas frontend en 16 archivos y 116 Rust correctas, 2 ignoradas; calidad normal y build/bundle Linux superados. Pendientes: selector e IPC WebView interactivo con SQLite real, salida física, calidad audible, USB/recuperación, latencias, estabilidad prolongada de recursos, Windows/macOS, instalación y accesibilidad integral. Estado y límites en [PHASE_6.md](PHASE_6.md).

## Validación y distribución de Fase 6

`scripts/check.mjs` y `tooling.mjs` coordinan herramientas existentes, validan Node y muestran versiones sin instalar globalmente. Cargo usa `--locked --offline` por defecto; `--online` permite preparación explícita con red y `--dry-run` muestra el plan. `scripts/toolchain.json` fija referencias Node 22.23.3/Rust 1.99.1 para CI; no implica imponer ni descargar un toolchain local.

`infrastructure/audio/performance.rs` está bajo `cfg(test)`: benchmark ignorado en la suite normal, exige release y consume el mezclador/driver reales en memoria sin abrir CPAL. No es una ruta de producto ni cambia el contrato de salida única. Los ADR siguen vigentes sin decisión nueva.

Los overrides `tauri.linux/windows/macos.conf.json` solo configuran bundles DEB, NSIS y app/DMG. El preflight comprueba versiones, identidad conservada, CSP, ACL de 25 comandos y dependencias Debian; devuelve siempre `publicationAllowed: false`. No es auditoría integral de seguridad. Los iconos derivan de `icons/radiofx.svg`, propio y provisional; derechos e identidad final requieren confirmación.

`scripts/artifacts.mjs` genera un manifiesto exclusivo de integridad con SHA-256, tamaños e inventario de fuentes tomado después del build. No acredita procedencia/frescura del binario, firma, autenticidad ni reproducibilidad bit a bit. Los workflows `quality.yml` y `distribution.yml` están preparados para hosts nativos, con permisos de repositorio de solo lectura y sin publicación/firma automática; no hay ejecución remota acreditada. Detalles y bloqueos en [RELEASE.md](RELEASE.md).

## Corrección: reinicio al repetir un efecto

La política de despacho solicitada explícitamente cambia a reinicio por recurso, manteniendo la capacidad multivoz del dominio. `NativeAudioController.play` envía opciones por defecto (`looped: false`, fades cero) y `playWithOptions` envía las opciones del disparo; ambos pasan por `api.restartEffect`. Paleta, teclado y diagnóstico comparten esa ruta. Ningún botón normal usa `play_effect` ni `play_effect_with_options`; estos conservan superposición explícita para núcleo, benchmarks y API de bajo nivel.

`restart_effect({ effectId, options }) -> playback_id` se serializa como una sola operación del worker, no como dos IPC frontend de parar y reproducir. Valida objetivo/opciones/volumen, salida, PCM y capacidad antes del corte; excluye del cómputo de cupo las voces que sustituirá. Retira todas las del mismo `effect_id`, incluidas loop/fade, y arranca desde cero con ID nuevo, volumen por defecto vigente y las opciones recibidas. Con 16 voces puede reutilizar el cupo propio, nunca robar el de otro efecto. Si falla el inicio del driver tras el corte, el objetivo queda detenido y el error visible; las demás voces no se alteran. Atomicidad de despacho no significa rollback del audio ni ausencia de instantáneas intermedias.

El alcance es todo el motor del proceso, no botón ni banco: asignar el mismo efecto a dos botones hace que se reinicien entre sí incluso en bancos distintos. No cambia el esquema SQLite ni las opciones por asignación. STOP conserva su barrera y las compuertas retiradas no se reabren; los buffers ya enviados al SO/hardware no pueden recuperarse. La demo sigue siendo visual.

Validación final con Node 22.23.3 y Rust 1.99.1: `npm run check:all` superado, 266 pruebas frontend en 16 archivos y 122 Rust correctas, 2 ignoradas; rustfmt y Clippy all-targets sin advertencias. `npm run bundle:linux` superado, con release Linux y DEB `0.1.0` reconstruidos con la corrección. El paquete sigue sin firma, solo de prueba y no instalado; una instalación anterior no se actualiza automáticamente. Artefacto y manifiesto vigentes en [RELEASE.md](RELEASE.md#artefacto-vigente-con-la-corrección), evidencia y regresiones en [VERIFICATION.md](VERIFICATION.md#corrección-reinicio-al-repetir-un-efecto). No se realizaron pruebas GUI/audio/hardware para esta corrección; se conservan históricos y benchmarks. No se abre otra fase ni se autoriza publicación.
