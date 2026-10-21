# Motor de audio

## Alcance implementado

Fases 3/4/5 autorizadas e implementadas: reproducción nativa con **Rodio 0.21.1** (`default-features = false`, solo `playback`), **CPAL 0.16** transitivo y UUID, con `Cargo.lock`. Fase 4 añade biblioteca e importación con **Symphonia 0.5.5**; Fase 5 implementa loops, fades y paquetes, sin dependencias runtime nuevas. Fase 6 autorizada añade calidad y benchmark offline superados en Linux. Arranque/reapertura del proceso GUI comprobados, no interacción completa ni audio físico; no se afirma soporte operativo Windows/macOS ni fase cerrada.

El catálogo incorpora archivos gestionados y precargados, además de tres señales de diagnóstico separadas. La paleta persistente dispara recursos reales; la demo del navegador no alimenta el motor. Hay decoder, importador y SQLite, pero **no streaming ni caché LRU**.

## Recursos precargados

`NativeDriver::new` precalcula PCM mono `f32` a 48 kHz con envolventes de entrada/salida y amplitud máxima 0.18. Las instancias comparten muestras mediante `Arc<[f32]>` pero mantienen cursores independientes.

| effect_id           | Señal                       | Duración | Frecuencia base | Bytes PCM |
| ------------------- | --------------------------- | -------- | --------------- | --------- |
| `native-test-chime` | Aguda                       | 450 ms   | 880 Hz          | 86400     |
| `native-test-pulse` | Pulsada, modulación de 8 Hz | 300 ms   | 440 Hz          | 57600     |
| `native-test-low`   | Grave                       | 4000 ms  | 220 Hz          | 768000    |
| Total               | Tres recursos fijos         | 4750 ms  |                 | 912000    |

912000 bytes es el contenido PCM diagnóstico, incluido en el presupuesto descrito abajo, no el consumo total del proceso. No se generan muestras mediante trigonometría ni se leen archivos al disparar o en el callback.

## Archivos y presupuesto PCM

Symphonia 0.5.5 habilita únicamente `wav`, `pcm`, `mp3`, `ogg`, `vorbis`, `flac`. Se han decodificado fixtures reales de los cuatro formatos, generados con FFmpeg 6.1.1 y conservados en `src-tauri/tests/fixtures/tone.{wav,mp3,ogg,flac}`. El uso normal y las pruebas consumen esos bytes offline, sin ejecutar FFmpeg. WAV se limita a PCM; OGG es Vorbis, no Opus. No se garantiza toda variante de los contenedores. Se comprueban extensión, firma, formato del decoder, parámetros estables, muestras finitas y truncamientos/corrupciones detectables; esto no es una garantía de detectar cualquier archivo alterado.

| Límite                | Política                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Archivo de entrada    | 1 byte..32 MiB, archivo regular; no se confía solo en la extensión.                      |
| PCM por recurso       | Máximo 32 MiB de f32 y 120 s; ambos límites se aplican.                                  |
| Canales y frecuencia  | 1..2 canales, 8000..192000 Hz.                                                           |
| Catálogo / selección  | 4096 efectos; hasta 256 archivos por importación, resultados parciales visibles.         |
| Presupuesto PCM total | 128 MiB, incluidos 912000 bytes diagnósticos y 32 MiB reservados a adaptación de salida. |

Todos los recursos disponibles se precargan; no se expulsa por LRU ni se transmite audio largo desde disco. El pool de entrada es `128 MiB - 912000 - 32 MiB`. Catálogo y voces comparten `Arc<[f32]>` con cursores independientes. Cada decode admite como máximo `min(32 MiB, (libre - 2 MiB) / 2)` y el límite de 120 s: reserva dos copias transitorias Vec/Arc y 2 MiB de seguridad para bloques. El exceso se rechaza explícitamente sin cortar recursos existentes.

**No es un límite de RSS**: bytes del formato, buffers de probe/decoder, metadatos, estructuras y memoria del dispositivo se suman fuera de ese presupuesto. No se promete memoria total del proceso acotada a 128 MiB ni latencia de primera conversión.

La conversión de frecuencia/canales se materializa en CPU dentro del worker, antes del render, sin I/O ni decoder en ese worker. Su pool compartido de 32 MiB contempla el doble coste Vec/Arc y reserva transitoria; adaptaciones activas siguen presupuestadas y pueden impedir otra conversión. La primera pulsación en frío o tras cambiar salida paga conversión; Fase 6 mide solo un caso offline mono a estéreo, no su latencia física ni todos los formatos. No se abre un stream adicional por recurso.

La preparación de paquetes contabiliza también PCM pendiente y pins activos. Un hash/formato/tamaño ya conocido y validado reutiliza su Arc PCM; no vuelve a decodificar ni consume una segunda reserva por el mismo Arc. Los recursos nuevos se decodifican contra presupuesto libre, incluyendo lo preparado previamente. La deduplicación conserva conversiones activas y permite nuevos disparos bajo presupuesto estrecho sin invalidar el PCM sano compartido. El límite de 256 MiB del paquete no es un límite RSS: al exportar coexisten bytes de recursos y el ZIP codificado, cada conjunto acotado, además del PCM y estructuras.

### Invalidación y recuperación final

Inicio, consulta explícita de biblioteca e importación revalidan disco/hash fuera del audio. No hay watcher continuo ni garantía de detectar una edición externa antes del siguiente refresco. Un archivo ausente/alterado queda visible y rechaza disparos nuevos; voces existentes pueden terminar usando PCM fijado.

El PCM retirado sigue contando mientras tenga pins externos. Al registrar un recurso no disponible o cambiado, el driver libera su antiguo `conversion_inputs`; retira conversiones ociosas obsoletas, pero conserva y presupuesta las adaptaciones aún fijadas por voces/render. Así una conversión ociosa no retiene indefinidamente el PCM de entrada. La nueva versión no reutiliza una adaptación del PCM anterior ni interrumpe voces para ganar memoria.

`LibraryService::synchronize` realiza como máximo dos pases: revalidar, registrar/liberar pins ociosos y, solo si faltó presupuesto PCM, revalidar una vez más. PCM antiguo realmente activo puede bloquear hasta finalizar o parar esas voces; **STOP seguido de Actualizar biblioteca** permite recuperar sin reseleccionar salida. Esto no promete que STOP libere todo buffer ya entregado al hardware.

La lista de fuentes pendientes/retiradas del render tiene un máximo de 128. Si el render deja de consumir, nuevos disparos reciben `render_backpressure` en lugar de acumular metadatos indefinidamente; la recuperación indicada es reseleccionar salida. Este caso es distinto del refresco normal tras liberar pins.

Reimportar bytes sanos del mismo hash repara una copia gestionada ausente o inválida con un UUID de archivo nuevo, preservando `effect_id`, asignaciones, nombre y volumen; devuelve `duplicate: true`. No sobrescribe ni borra la copia alterada ni los originales. El registro tardío nunca reproduce ni rearma STOP. Durante carga inicial `play_effect` rechaza inmediatamente, sin reproducción diferida.

## Salida única

Al arrancar no se abre stream ni se elige la salida predeterminada. La UI solicita enumeración y el usuario confirma una salida. CPAL no ofrece aquí identidad portable: cada enumeración crea tokens UUID nuevos y conserva el handle real correspondiente en el worker. Tras una renovación los tokens previos ya no permiten seleccionar; el handle de la salida activa se mantiene aparte. Nombres duplicados no acreditan una identidad ni un predeterminado inequívoco.

Un único `OutputStream` por motor/instancia de aplicación recibe una mezcla común. Cada voz usa un `Sink`, no otro stream. Un origen de silencio mantiene vivo el mezclador cuando no hay voces. Dos procesos con la misma SQLite conservan motores independientes, no una salida global sincronizada.

El cambio solicitado detiene voces, cierra la salida anterior e intenta abrir la nueva. Si falla, intenta recuperar el handle anterior conservado, incluso tras renovar la lista; comunica `restored_previous`, `error` e instantánea. No reanuda voces ni prueba una salida predeterminada como fallback. Si también falla restaurar, queda `device_error`. Los metadatos de salida pueden seguir visibles, marcados como no disponibles, y no equivalen a `ready`.

El callback de error solo activa un indicador atómico. El worker lo consume, retira voces y cierra la salida sin redirección automática. La recuperación requiere selección explícita. SQLite persiste solo el nombre preferido, no el token: la UI informa coincidencia única como sugerencia, o ausencia/ambigüedad. Incluso una coincidencia única exige elección y confirmación; ningún arranque abre salida automáticamente.

## Voces y ganancias

- Cada disparo aceptado crea un `playback_id` con UUID del motor y contador, independiente del `effect_id`. Los botones reinician el efecto: sustituyen todas sus voces anteriores por una nueva desde cero; otros efectos siguen mezclándose. La API de bajo nivel permite superposición explícita del mismo recurso.
- Límite inicial 16, configurable entre 1 y 64. Con 16 activas se rechaza una voz adicional con `voice_limit` sin robar voces; reiniciar un efecto activo reutiliza su cupo sin exigir uno extra. No se reduce el límite por debajo de las voces activas.
- Paradas por instancia, por efecto y general; las paradas de instancias ya ausentes son idempotentes. Una ganancia dirigida a una voz ausente devuelve `unknown_playback`.
- Finalizaciones liberan sinks y capacidad; el worker reconcilia cada 10 ms y antes de las operaciones. No se requiere otra acción de la UI para recolectarlas.
- Ganancias maestro, de instancia y por defecto: números finitos 0..1, sin corrección silenciosa. Maestro inicial 0.7, valores por defecto 0.5.
- La ganancia por defecto se copia al crear la instancia; editarla solo afecta a futuras voces. La ganancia de instancia controla una voz; el maestro atómico controla la mezcla actual completa.
- Un fallo al iniciar una voz se publica como `audio:playback-error` sin cortar las demás. Archivos inválidos/importaciones fallidas se aíslan fuera del motor; recursos ya preparados pueden continuar.
- Maestro, límite y valores por defecto (también diagnósticos) son durables. Se aplican al motor antes de escribir SQLite fuera del worker; un fallo posterior informa `persistence_partial_failure` sin fingir rollback del audio. Ganancias de instancia y voces no se restauran al reiniciar.

## Loops y fades de Fase 5

Cada botón de producción conserva `playback: { looped, fadeInMs, fadeOutMs }`; los fades son enteros 0..30000 ms. En reproducción simple la suma debe caber en la duración real del recurso. `play_effect` conserva opciones por defecto sin loop ni fades; `play_effect_with_options` permite las opciones explícitas. Ambos crean otra voz del mismo recurso y respetan la barrera de STOP y el límite.

El cursor de cada voz recorre PCM ya adaptado y compartido; al repetir vuelve al inicio sin copiar PCM por vuelta ni reservar un buffer infinito. El fade de entrada se aplica una vez, no se reinicia en cada vuelta. Desactivar loop permite terminar la vuelta actual; el fade de cola configurado corresponde al final de la reproducción simple o a esa última vuelta, no a cada repetición. No hay crossfade ni garantía audible gapless.

La envolvente es coherente por frame/canales y progresa según muestras consumidas en el reloj de salida, no por un deadline de pared. `fade_out_playback` inicia una única salida explícita; cero corta inmediatamente. Mientras el render no la consume, la voz permanece `fading_out`, activa y contando contra el límite. Repetir la solicitud no extiende la salida ni revive una voz; cambiar loop tampoco revierte un fade iniciado. Al retirarla se emite `audio:playback-stopped`; el final natural emite `audio:playback-finished`.

`stop_playback`, `stop_effect`, `stop_all`, cambio y fallo de dispositivo conservan corte inmediato sin fade. El STOP atómico no espera envolventes, I/O ni la cola. Las rutas de disparo antigua y con opciones solo rearman tras un nuevo disparo aceptado; nunca reviven voces retiradas. Los siete eventos siguen llevando instantáneas completas, sin frames de audio por IPC.

## Mezcla y protección

El driver normaliza cada voz al número de canales y frecuencia de la salida, coloca después una compuerta irreversible de vida y suma en el mezclador compartido. La fuente protegida final aplica el maestro y la saturación suave:

```text
x = muestra_mezclada * ganancia_maestra
salida = 0.95 * tanh(x / 0.95)
```

Entradas no finitas a la protección producen cero. Las pruebas numéricas comprueban finitud, simetría, silencio con maestro cero y pico absoluto <= 0.95, incluidas mezclas y remuestreo sin dispositivo. **Es una saturación suave que colorea el audio, no un limitador transparente**, ni una validación auditiva. Limitar ganancias a 1 no basta para evitar saturación de la suma; esta protección no permite prometer ausencia de clipping en drivers, conversiones o hardware reales. Calidad audible, clics/transitorios y niveles de salida deben evaluarse manualmente.

## Worker y emergencia

`AudioService` construye driver, stream y motor dentro de un worker único propietario. Operaciones normales usan una cola acotada a 64 con `try_send`; al llenarse devuelve `request_queue_full`. La espera de respuestas ocurre fuera del hilo principal y del callback. Enumeración/apertura/cierre de driver y emisión de eventos ocurren en el worker; no hay disco, SQLite, decodificación, red, logging síncrono ni tareas UI en el callback.

`stop_all` tiene dos momentos distintos:

1. **Corte:** activa directamente un `AtomicBool`, fuera de la cola normal. `ProtectedSource` devuelve cero antes de consumir el mezclador y comprueba de nuevo el corte tras obtener una muestra. No espera al worker, incluso si está bloqueado enumerando dispositivos.
2. **Confirmación:** el worker detiene las voces, cancela y drena las órdenes normales pendientes, incluidas consultas y ganancias, con `request_cancelled`, y solo entonces confirma. Durante la barrera las nuevas órdenes normales reciben `stop_in_progress`. Las paradas concurrentes comparten confirmación.

El corte queda activo tras confirmar. Solo un **nuevo disparo aceptado después de la barrera** lo rearma; una reproducción rechazada, ganancias, consultas, límite o selección de dispositivo no desmutean. Una parada llegada durante un disparo impide que ese disparo revierta su corte.

Al retirar cada voz se invalida su `live` atómico después del remuestreo: ni muestras retenidas por el remuestreador ni por controles periódicos del Sink permiten que una voz antigua reaparezca tras rearmar. Se prueba con frames estéreo pendientes y rearme rápido.

Un driver bloqueado puede retrasar el ACK de parada o el shutdown, aunque el render siga entregando cero por el corte independiente. No se pueden retirar buffers ya enviados al sistema/hardware. El sondeo de 10 ms y el corte por muestra no constituyen una promesa de latencia audible.

## Contrato de comandos

Los diecisiete comandos de audio aceptan argumentos IPC camelCase y respuestas de audio snake_case. Ocho comandos de biblioteca/paquetes completan los veinticinco registrados y usan instantáneas camelCase. Acciones sin payload se serializan como `null`, validado por el adaptador; errores de dominio contienen `{ code, message }`.

| Comando                        | Argumentos IPC                                    | Resultado                                                 |
| ------------------------------ | ------------------------------------------------- | --------------------------------------------------------- |
| `get_audio_engine_status`      | Ninguno                                           | `AudioEngineStatus`                                       |
| `list_output_devices`          | Ninguno                                           | `OutputDevice[]`, tokens renovados                        |
| `get_selected_output_device`   | Ninguno                                           | `OutputDevice` o `null`                                   |
| `set_output_device`            | `{ deviceId }`                                    | `{ status, restored_previous, error }`                    |
| `play_effect`                  | `{ effectId }`                                    | `playback_id` string                                      |
| `restart_effect`               | `{ effectId, options: PlaybackOptions }`          | `playback_id` nuevo; sustituye todas las voces del efecto |
| `stop_playback`                | `{ playbackId }`                                  | `null`                                                    |
| `stop_effect`                  | `{ effectId }`                                    | `null`                                                    |
| `stop_all`                     | Ninguno                                           | `null`, tras confirmar la barrera                         |
| `set_master_volume`            | `{ value }`                                       | `null`                                                    |
| `set_playback_volume`          | `{ playbackId, value }`                           | `null`                                                    |
| `set_effect_volume`            | `{ effectId, value }`                             | `null`, solo futuras voces                                |
| `set_max_concurrent_playbacks` | `{ value }`                                       | `null`                                                    |
| `get_active_playbacks`         | Ninguno                                           | `Playback[]`                                              |
| `get_library_snapshot`         | Ninguno                                           | Biblioteca revalidada y registrada                        |
| `save_board`                   | `{ board, expectedRevision }`                     | Instantánea durable o conflicto                           |
| `set_library_columns`          | `{ columns }`                                     | Instantánea durable                                       |
| `import_audio_files`           | Ninguno, selector Rust                            | Cancelación, éxitos/duplicados, fallos e instantánea      |
| `play_effect_with_options`     | `{ effectId, options }`                           | `playback_id`; options: `looped`, `fadeInMs`, `fadeOutMs` |
| `set_playback_loop`            | `{ playbackId, looped }`                          | `null`                                                    |
| `fade_out_playback`            | `{ playbackId, durationMs }`                      | `null`                                                    |
| `prepare_bank_import`          | Ninguno, selector Rust                            | Cancelación o vista previa con token                      |
| `commit_bank_import`           | `{ token, expectedRevision, enableShortcuts }`    | Instantánea, IDs de bancos nuevos, reutilizados y avisos  |
| `cancel_bank_import`           | `{ token }`                                       | `null`                                                    |
| `export_sound_banks`           | `{ bankIds, expectedRevision, includeShortcuts }` | Cancelación o recuentos/bytes/avisos; selector Rust       |

`AudioEngineStatus` contiene `engine_id` UUID, `revision`, `state` (`not_initialized`, `ready`, `device_error`), `selected_device`, `active_playbacks`, `master_volume`, `max_concurrent_playbacks`, `last_error` y `effects`. Cada voz contiene `playback_id`, `effect_id`, `volume`, `looped`, `state` (`playing` o `fading_out`) y `fade_out_ms`. El dispositivo contiene `id`, `name`, `is_default`; cada efecto, `effect_id`, `name`, `duration_ms`, `default_volume`.

## Eventos y frontend

Los seis eventos previstos están implementados, más `audio:state-changed` para ganancias/límite:

```text
audio:playback-started
audio:playback-finished
audio:playback-stopped
audio:playback-error
audio:device-changed
audio:device-error
audio:state-changed
```

Todos llevan la instantánea completa del motor. Cambios observables incrementan revisión; consultas no. Los rechazos de disparo publican error y revisión; otras validaciones rechazadas no modifican el estado. React valida resultados y eventos `unknown` con Zod, escucha antes de consultar y reconcilia cada 1500 ms, además de consultas explícitas/tras operaciones. Revisión, secuencia de consulta y época protegen contra resultados obsoletos; solo una consulta confirma un nuevo motor.

No hay voces optimistas. Ganancias/límite conservan una solicitud en curso y la última pendiente por control. STOP descarta pendientes frontend anteriores, no IPC enviado; finalizaciones descartan pendientes de la voz retirada. El borrador de límite se aplica mediante botón/Enter, separado del valor confirmado por Rust. El controlador limpia listeners, timer y respuestas tardías al desmontar, también bajo StrictMode.

## Verificación y pendientes

Resultados finales de Fase 5: 110 pruebas Rust correctas (79 anteriores + 31 nuevas), 1 de hardware ignorada; `npm run check` superado con Node 22.23.3 cacheado, tipos, lint, formato, 233 pruebas frontend en 15 archivos (142 anteriores + 91 nuevas) y build. Formato Rust `--all --check`, Clippy `--all-targets -D warnings` y build Linux superados con Cargo `--locked --offline` donde corresponde. Ambas cadenas finales incluyen las regresiones correspondientes; los recuentos históricos de Fase 4 se conservan en VERIFICATION. Las pruebas usan SQLite temporal, fixtures reales, fuentes/mezcla consumidas en memoria y driver simulado, sin sonido físico. La prueba de apertura real ignorada exige `RADIOFX_TEST_OUTPUT_NAME`, una coincidencia inequívoca y no reproduce señales; no se ejecutó.

La prueba Tauri usa handlers/ACL y contexto de producción generado con runtime y transporte simulados. No es IPC desde una WebView real. Tampoco el recorrido Chrome con IPC falso demuestra salida de audio.

Las regresiones cubren pins/conversiones, presupuesto estrecho y deduplicación PCM con loop activo, STOP/refresco sin reselección y backpressure; Fase 5 añade cientos de vueltas sobre el mismo PCM, fin de vuelta al desactivar loop, extremos/coherencia estéreo de fades, progreso solo por render, capacidad retenida durante fade, eventos y corte/rearme de ambas rutas de play. No son benchmarks de RSS ni pruebas auditivas.

Fase 6 registra 116 pruebas Rust correctas y 2 ignoradas (hardware y benchmark opt-in), además de 264 frontend en 16 archivos. El benchmark `cfg(test)` exige `--release` y usa `NativeDriver`, `Engine` y `AudioService` reales con render en memoria: nunca enumera ni abre CPAL. Mide bloques de 512 frames estéreo a 48 kHz con 1/16/64 voces en loop, adaptación y ACK/corte por separado. Los 500 ciclos de estrés alternan 250 finales naturales y 250 paradas de voces aún activas; comprueban pools/handles propios, no ausencia universal de fugas ni estabilidad RSS.

El informe y contexto reproducible están en [PHASE_6.md](PHASE_6.md#benchmark-offline). El p95 de render con 16 voces fue 528.256 microsegundos por bloque de 10.667 ms de audio representado. Es throughput software con comprobaciones numéricas incluidas, no porcentaje de CPU ni latencia audible. ACK de STOP y corte hasta el siguiente bloque se miden en ensayos separados y ninguno incluye buffers del dispositivo.

Pendiente: selector nativo, recorrido SQLite/WebView interactivo, sonido físico seleccionado, USB/desconexión/recuperación, calidad auditiva de loops/fades y clipping real, latencias físicas, CPU/RSS prolongados y Windows/macOS. El arranque GUI puede enumerar dispositivos y producir avisos ALSA; no se seleccionó stream activo ni se reprodujo audio. Las metas audibles p95 < 50 ms siguen sin medir. Checklist vigente en [HARDWARE_TESTS.md](HARDWARE_TESTS.md), evidencia en [VERIFICATION.md](VERIFICATION.md), decisiones sin cambios en ADR-001/002/003/004. Publicación bloqueada según [RELEASE.md](RELEASE.md).

## Corrección: reinicio al repetir un efecto

El requisito explícito vigente es reiniciar desde cero al pulsar de nuevo el mismo sonido, sin acumular copias; los sonidos distintos siguen mezclándose. Esta política sustituye el despacho normal descrito históricamente, no elimina la capacidad de superposición explícita de `play_effect` y `play_effect_with_options` para núcleo, benchmarks y API de bajo nivel.

`restart_effect({ effectId, options }) -> playback_id` requiere `PlaybackOptions` (`looped`, `fadeInMs`, `fadeOutMs`). Una sola operación serializada del worker valida efecto, opciones, volumen por defecto, estado de salida, PCM disponible y cupo antes de cortar. Un rechazo previo conserva las voces anteriores, aunque publique error. La capacidad se calcula descontando todas las voces del objetivo: con 16 activas puede reiniciarse un efecto que ya ocupa cupo; sin cupo propio o libre se rechaza sin robar voces ajenas.

Después de validar se cortan todas las voces del objetivo, incluso loop y `fading_out`, y se crea una nueva con ID distinto, cursor y envolvente desde el frame cero, volumen por defecto vigente y opciones recibidas. No hereda volumen de instancia ni fade en curso. Si el driver falla al iniciar tras el corte, no hay restauración de voces anteriores: error visible mediante estado/evento y otros efectos intactos. La operación es atómica respecto al despacho del worker, no una transacción reversible ni una promesa de continuidad audible; puede publicar instantáneas de parada antes del inicio.

`NativeAudioController.play` usa opciones por defecto sin loop/fades y `playWithOptions` las del disparo; ambos llaman `api.restartEffect`. Paleta, atajos y diagnóstico comparten esa ruta, sin parar/reproducir mediante dos IPC. El alcance es `effect_id` en todo el motor: botones del mismo recurso, incluso en bancos diferentes, se reinician entre sí. No cambia SQLite ni las opciones por asignación; dos procesos siguen teniendo motores separados. La demo solo representa estados visuales.

STOP conserva corte/barrera y cancelación de pendientes; un reinicio concurrente no puede reabrir una compuerta retirada ni revertir el corte. Solo una nueva admisión aceptada tras la barrera rearma. Muestras ya entregadas al SO/hardware no pueden retirarse.

Validación final y regresiones en [VERIFICATION.md](VERIFICATION.md#corrección-reinicio-al-repetir-un-efecto): `npm run check:all` superado con Node 22.23.3 y Rust 1.99.1, 266 pruebas frontend en 16 archivos, 122 Rust correctas y 2 ignoradas, rustfmt y Clippy all-targets sin advertencias. `npm run bundle:linux` superado: release Linux y DEB `0.1.0` reconstruidos con la corrección. Hash y manifiesto actuales en [RELEASE.md](RELEASE.md#artefacto-vigente-con-la-corrección). El DEB sigue sin firma, solo de prueba y no instalado; generar el paquete no actualiza automáticamente un binario instalado anteriormente. No se realizaron pruebas GUI/audio/hardware ni nuevas mediciones de latencia para esta corrección. Benchmarks e históricos intactos, sin nueva fase ni autorización de publicación.
