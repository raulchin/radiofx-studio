# ADR-003: estado autoritativo en Rust

## Estado

Decisión aceptada e implementada en Fases 3/4/5 autorizadas. Operaciones, eventos, biblioteca durable, funciones profesionales y pruebas disponibles; compilación Linux superada. Arranque GUI, IPC desde WebView real y hardware pendientes. Los resultados históricos permanecen en [VERIFICATION.md](../VERIFICATION.md). Fase 6 requiere autorización.

## Contexto

Duplicar voces o dispositivo en React y Rust produce estados fantasma. Los eventos pueden perderse o llegar mientras consultas anteriores siguen en curso; un reinicio puede cambiar el motor. El control de emergencia tampoco puede depender de que avance una cola saturada o un worker bloqueado por un driver.

## Decisión

Rust es fuente de verdad de dispositivo, voces, catálogo nativo, ganancias y límite. React presenta instantáneas y envía comandos, sin mezclar ni usar `HTMLAudioElement`. El dominio usa Serde para serialización, sin dependencia de Tauri o SQLite; aplicación mantiene reglas y puerto de driver, infraestructura implementa Rodio/CPAL y commands adapta Tauri. Los modelos serializables actuales se comparten en el borde, sin DTOs duplicados.

`AudioService` construye motor y driver en un worker único propietario del stream. Las operaciones normales pasan por una cola acotada de 64 y reciben `request_queue_full` al saturarla. El callback no realiza disco, SQLite, decodificación, logging síncrono, red ni UI. Señal de fallo, maestro y corte se comunican mediante atómicos.

`stop_all` evita la cola y activa directamente el corte atómico en `ProtectedSource`, sin esperar a enumeración/apertura del driver. El worker retira voces, cancela pendientes normales (también consultas y ganancias) con `request_cancelled` y confirma después de drenar. Durante la barrera rechaza admisiones con `stop_in_progress`; paradas concurrentes comparten ACK. El corte permanece hasta un nuevo disparo aceptado tras la barrera. Consultas, ganancias y selección no desmutean; las voces antiguas no reviven gracias a su compuerta irreversible posterior al remuestreo.

El ACK y shutdown pueden retrasarse por una llamada bloqueada de driver. El corte de muestras futuras no depende de ese avance, pero no retira buffers ya entregados al hardware ni garantiza latencia física.

## Contrato y orden

Veinticinco comandos tipados: diecisiete de audio con argumentos camelCase y respuestas snake_case, y ocho de biblioteca/paquetes con instantáneas camelCase; el nuevo comando es `restart_effect`. Fase 5 añade `play_effect_with_options`, `set_playback_loop`, `fade_out_playback`, `prepare_bank_import`, `commit_bank_import`, `cancel_bank_import` y `export_sound_banks`. Los adaptadores reciben `unknown`, validan resultados/eventos mediante Zod estricto y validan argumentos antes de enviarlos. Los errores de dominio incluyen código y mensaje. Fallos de transporte o validación se muestran sin inventar estado operativo.

Cada instantánea completa incluye `engine_id` UUID, revisión monotónica y estado, salida, voces, ganancias, límite, catálogo y último error. Los seis eventos previstos más `audio:state-changed` contienen esa instantánea, no deltas. Cambios observables incrementan revisión; las consultas no. Un rechazo de disparo publica `playback-error` y `last_error`; otras validaciones fallidas no mutan el estado.

En Fase 5 las voces incluyen `looped`, `state` (`playing`/`fading_out`) y `fade_out_ms`. Rust controla cursor, envolventes y retiro por render, sin frames de audio ni progreso por muestra enviados a React. Fade explícito ocupa cupo hasta retirarse, con evento stopped; final natural usa finished. STOP y cambio/fallo de dispositivo siguen cortando sin fade; ambos comandos de play respetan la barrera y no reviven voces antiguas.

El controlador instala las siete escuchas antes de consultar. Reconcilia mediante consulta explícita, tras operaciones y cada 1500 ms; el polling no reenumera ni selecciona dispositivos. Descarta revisiones antiguas. Eventos de otro motor quedan a la espera de una consulta autoritativa; secuencias, épocas y motores retirados evitan que consultas tardías reviertan el motor vigente. Limpieza de timers, listeners incluso tardíos y generación de montaje protegen desmontaje/StrictMode.

No hay voces, ganancias ni salida confirmada optimistas. La UI conserva borradores, selección en el formulario y estado de operación. El límite requiere botón/Enter y muestra aparte lo confirmado por Rust. Cada ganancia/límite mantiene una solicitud en curso y la última pendiente por control; finalizar una voz o cambiar de motor descarta intenciones obsoletas. STOP descarta las pendientes frontend previas, no cancela IPC ya enviado.

## Producción y demo

Zustand conserva exclusivamente bancos mock, estados demo, columnas y volumen visual. `SoundButton.id` no es `playback_id` y sus `effectId` mock no son los recursos del catálogo Rust. La demo no reproduce ni pausa voces. Su pie **Restablecer demo** no envía `stop_all`; el panel **STOP ALL · audio nativo** y Ctrl+Shift+Space sí lo hacen, incluso con un modal abierto dentro de la aplicación. No es un atajo global del sistema.

El repositorio mock sigue síncrono y en memoria, solo para la demo. `App` elige `PersistentStudio` en Tauri: un fallo SQLite no activa mocks. `LibraryController` usa cola asíncrona y publica únicamente confirmaciones; ante conflicto invalida pendientes y recarga sin reenviar la edición. `usePersistentSoundboard` coordina formularios separados de la vista. Un botón persistente refiere el efecto real y usa recuentos nativos; cada clic solicita reiniciarlo desde cero sustituyendo sus voces anteriores, no modifica estados demo. Durante I/O se deshabilita edición, no disparos confirmados ni STOP.

`LibraryService` inicializa, lee/escribe SQL y decodifica en blocking pool fuera del worker/callback. El worker recibe PCM compartido y adapta canales/frecuencia en CPU con presupuesto separado, sin disco/decoder. `play_effect` rechaza inmediatamente durante carga inicial; registrar recursos tarde nunca reproduce ni rearma STOP. La sincronización invalida entradas/pins obsoletos y revalida hasta dos pases si faltó presupuesto, manteniendo conversiones activas contabilizadas.

SQLite es autoritativa de biblioteca/configuración durable; el motor de audio sigue siendo autoritativo del estado sonoro actual. Solo el tablero usa revisión optimista, las preferencias se escriben por campo y las recargas leen SQL fresco en transacción coherente. No se sincronizan globalmente los motores de dos procesos. Maestro/límite/defaults se aplican primero al motor: si falla guardar, el error parcial indica que el audio ya cambió. La preferencia de nombre jamás abre automáticamente una salida.

## Permisos

`build.rs` declara los veinticinco comandos con `AppManifest::commands`; la capability los concede solo a `main`, más escucha y liberación de eventos. No se permite emisión frontend, shell o acceso general a archivos. El selector se invoca desde Rust sin rutas IPC ni permiso de diálogo para JS. El backend emite a `main`. CSP local de producción y desarrollo localhost; opener eliminado.

Las pruebas Tauri usan el contexto de producción generado, handlers y autoridad ACL con runtime/transporte simulados. Comprueban camelCase, resultados, errores, tokens caducados, autorización de `main`, escucha/liberación, y denegación de otra ventana, origen remoto y emisión frontend. No equivalen a IPC en una WebView real ni a validación GUI de CSP.

## Consecuencias y verificación

- React puede perder eventos y recuperarse mediante instantáneas sin construir un segundo motor.
- Cola y coalescencia acotan trabajo pendiente; la emergencia sigue disponible con cola llena.
- Corte de render y confirmación de estado son garantías distintas y deben probarse por separado.
- Pruebas de carreras, revisión/motor, eventos perdidos, StrictMode, UI y emergencia están automatizadas; resultados en [VERIFICATION.md](../VERIFICATION.md).
- Validación final Fase 5: `npm run check` con Node 22.23.3 cacheado, tipos, lint, formato, 233 pruebas en 15 archivos (142 + 91) y build superados; Rust 110 correctas (79 + 31), 1 hardware ignorada, formato `--all --check`, Clippy `--all-targets -D warnings` y build Linux superados con `--locked --offline` donde corresponde.
- Pendientes arranque desktop, selector nativo, SQLite desde WebView/IPC real, hardware, latencias y plataformas adicionales; checklist actual en [PHASE_5.md](../PHASE_5.md), históricos en PHASE_3/4. No iniciar Fase 6 sin aprobación.

## Coordinación de Fase 5

El tablero durable pasa a v2 con opciones y `keyboardShortcuts`; la demo v1 sigue separada. Los atajos se validan en Rust/TypeScript y se despachan desde un único listener raíz usando `useEffectEvent` y el último ACK, sin registrar hotkeys del sistema. Se ignoran IME, AltGraph, repetición, campos y modales para acciones ordinarias; la emergencia reservada se procesa antes incluso en diálogos/campos. Búsqueda y filtros son UI, no nuevas posiciones persistidas. Mover/copiar usan guardado confirmado; mover elimina sus atajos de disparo con aviso y en la misma transacción.

Preparar paquetes no escribe bancos ni reproduce. Hay una preparación por proceso, token con caducidad perezosa de diez minutos y cancelación de respuestas tardías. El commit de recursos/tablero/opciones/atajos es atómico por revisión; un conflicto previo no consume el token en Rust, pero la UI lo cancela y exige nueva preparación. Aceptado el token, se consume incluso si falla; un error tras commit/registro se presenta como parcial y recarga, nunca repite la importación automáticamente. Registro y actualización de catálogo jamás rearman STOP. La búsqueda, el selector y la decodificación no se trasladan al callback de audio.

## Corrección: reinicio al repetir un efecto

El usuario exige que repetir un botón reinicie desde cero, sin copias acumuladas y manteniendo la mezcla de efectos distintos. `NativeAudioController.play` con opciones por defecto y `playWithOptions` con opciones explícitas llaman ambos a `api.restartEffect`. Paleta, teclado y diagnóstico comparten ese despacho; no hacen dos IPC de parada e inicio ni crean voces optimistas. `play_effect` y `play_effect_with_options` conservan superposición explícita para núcleo, benchmarks y API de bajo nivel, no para botones normales: cambia la política de despacho, no la capacidad multivoz del dominio.

Rust ejecuta `restart_effect({ effectId, options: PlaybackOptions }) -> playback_id` como una operación serializada del worker. Valida objetivo, opciones, volumen por defecto, salida, PCM y capacidad antes de cortar; rechazar conserva las voces previas. Descuenta las voces objetivo para poder reiniciar con 16 activas sin cupo adicional, sin robar otras. Corta todas las del mismo recurso, incluso loop/fade, y crea ID, cursor y envolvente nuevos desde frame cero, con volumen por defecto vigente y opciones recibidas. Fallar el inicio del driver tras el corte deja las antiguas retiradas y el error visible, sin afectar otros efectos. No es rollback del audio: eventos de parada e inicio pueden exponer instantáneas intermedias, reconciliables por revisión/consulta.

El alcance es `effect_id` en todo el motor del proceso, incluso entre asignaciones de bancos diferentes; no cambia esquema SQLite ni opciones por asignación. STOP conserva prioridad, barrera y cancelación de cola; un reinicio concurrente no puede deshacer el corte ni revivir fuentes retiradas. Los buffers ya entregados al SO/hardware no se pueden retirar. La demo solo es visual.

Registro y ACL actuales: 25 comandos (17 audio y 8 biblioteca/paquetes), incluido `restart_effect`, con argumentos camelCase y errores/instantáneas validados. Las regresiones IPC ejercitan handlers y autoridad ACL efectivos con runtime/transporte falsos, no WebView real. Validación final: `npm run check:all` superado con Node 22.23.3 y Rust 1.99.1, 266 pruebas frontend en 16 archivos, 122 Rust correctas y 2 ignoradas, rustfmt y Clippy all-targets sin advertencias. `npm run bundle:linux` superado, release Linux y DEB `0.1.0` reconstruidos con la corrección. El paquete sigue sin firma, solo de prueba y no instalado; una instalación anterior no se actualiza automáticamente. Artefacto vigente en [RELEASE.md](../RELEASE.md#artefacto-vigente-con-la-corrección), detalle en [VERIFICATION.md](../VERIFICATION.md#corrección-reinicio-al-repetir-un-efecto). No se realizaron pruebas GUI/audio/hardware para esta corrección. No se alteran históricos ni benchmarks, ni se abre otra fase o autoriza publicación.
