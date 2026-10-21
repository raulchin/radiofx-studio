# ADR-002: reproducción concurrente

## Estado

Decisión aceptada e implementada en Fases 3/4/5 autorizadas para señales diagnósticas y archivos importados precargados, ahora con loop y fades. Pruebas automatizadas y compilación Linux superadas; concurrencia audible, clipping físico y calidad auditiva pendientes. Fase 6 requiere autorización.

## Contexto

Una paleta de radio necesita superponer efectos y repetir un mismo sonido sin confundir el recurso del catálogo con sus ejecuciones. La saturación no debe cortar arbitrariamente audios que ya estén en antena.

## Decisión

`effect_id` identifica el recurso y `playback_id` una instancia concreta. Cada disparo aceptado crea una voz independiente, incluso si el efecto ya está sonando.

El límite inicial es de 16 instancias simultáneas, configurable entre 1 y 64. Con 16 voces activas, la solicitud de voz 17 se rechaza con error visible. No se roba la voz más antigua, no se sustituye otra instancia y no se detienen reproducciones existentes. Una reducción por debajo del número de voces activas también se rechaza.

Se soportan parada de una instancia, de todas las instancias de un efecto y `STOP ALL`. Las voces terminadas liberan recursos y capacidad. El fallo al iniciar una voz no detiene las demás. Importación y revalidación aíslan archivos inválidos fuera del motor; las voces existentes pueden terminar con PCM fijado y recursos sanos continúan disponibles.

Las ganancias se validan como números finitos en el intervalo cerrado de 0 a 1. El valor por defecto del efecto se copia al crear la instancia; sus cambios posteriores no modifican voces ya activas. El volumen de instancia afecta solo a esa voz y el maestro atómico a la mezcla completa. Valores iniciales: maestro 0.7 y por defecto 0.5.

La suma puede saturar aunque cada ganancia sea <= 1. Se implementa protección común después de la mezcla y el maestro mediante `0.95 * tanh(x / 0.95)`, donde `x` es mezcla por maestro; entradas no finitas producen cero. Las pruebas numéricas comprueban finitud y pico absoluto <= 0.95. Es **saturación suave que colorea el audio, no un limitador transparente**. No se afirma calidad audible ni ausencia de clipping en la salida física; requiere evaluación auditiva y técnica real.

La emergencia activa un corte atómico en la fuente final fuera de la cola normal de 64, incluso con worker bloqueado en enumeración. El worker detiene voces y cancela pendientes (`request_cancelled`) antes de confirmar; durante la barrera rechaza admisiones normales (`stop_in_progress`). Las voces tienen una compuerta irreversible después del remuestreo para impedir que reaparezcan muestras retenidas. Solo un nuevo disparo aceptado tras la barrera rearma; ganancias, consultas y selección no desmutean.

Corte y confirmación no son equivalentes: el driver puede retrasar ACK/shutdown y los buffers ya entregados al hardware no pueden retirarse. No se promete latencia audible de parada.

## Extensión de Fase 5

El botón conserva opciones `looped`, `fadeInMs` y `fadeOutMs`; los fades admiten enteros 0..30000 ms y, en reproducción simple, su suma no puede superar la duración real. Cada play con opciones crea una voz independiente; `play_effect` mantiene sus opciones por defecto. El cursor recorre el PCM adaptado compartido sin copiar por vuelta ni crear buffers infinitos; desactivar loop termina la vuelta actual. La entrada se aplica una sola vez, no se reinicia por vuelta. No hay crossfade ni garantía audible gapless.

La envolvente avanza por frames/canales consumidos en el reloj de salida, no por deadline de pared. El fade explícito cambia a `fading_out` y conserva la voz/cupo hasta que el render termina; repetirlo no lo extiende, ni cambiar loop revive una salida iniciada. Cero corta. El retiro de una salida explícita emite `audio:playback-stopped`; el final natural, `audio:playback-finished`. `stop_playback`, `stop_effect`, `stop_all`, error y cambio de dispositivo cortan sin fade. Ambas rutas de disparo respetan el corte/rearme atómico y las compuertas irreversibles.

## Consecuencias

- No hay cortes arbitrarios al alcanzar el límite, pero el usuario debe recibir el rechazo de un nuevo disparo.
- El estado autoritativo debe distinguir recursos e instancias y limpiar las voces finalizadas.
- El límite de ganancia por sí solo no permite afirmar ausencia de clipping.
- La configuración del límite requerirá validación; no constituye una promesa de capacidad ilimitada.

## Validación y pendientes

Se prueban voces independientes, rechazo de la 17 sin robo, límites/ganancias inválidos, semántica de ganancias, paradas idempotentes, finalización, fallos de inicio aislados y cientos de ciclos con driver simulado. Render en memoria prueba mezcla/PCM, remuestreo estéreo, limpieza, picos finitos, emergencia con driver bloqueado y ausencia de reaparición tras rearme rápido. No se abre salida física en estas pruebas.

Fase 4 conserva las pruebas previas y añade importaciones reales con SQLite temporal, doble disparo desde paleta, límites de PCM y adaptación compartida, invalidación sin cortar voces y STOP durante I/O. La precarga completa tiene presupuesto PCM total de 128 MiB, no RSS ni LRU/streaming; adaptación CPU en worker con reserva de 32 MiB. PCM retirado/conversiones activas siguen contando; se liberan pins ociosos obsoletos y la sincronización revalida hasta dos veces. Una voz antigua puede bloquear memoria hasta finalizar/STOP seguido de refresco. El render detenido impone backpressure a 128 fuentes, no acumulación indefinida. Véase [AUDIO_ENGINE.md](../AUDIO_ENGINE.md).

Pendientes: señales simultáneas audibles, calidad/coloración/transitorios, picos y clipping reales, latencias y CPU/memoria medidas con hardware. Los checklists de [PHASE_4.md](../PHASE_4.md) y [PHASE_3.md](../PHASE_3.md) exigen niveles bajos y selección autorizada; no probar 16 voces a volumen máximo sin validación previa.

Fase 5 añade pruebas sin hardware de cientos de vueltas sobre el mismo PCM, fin de vuelta, envolventes estéreo/extremos, fade que solo progresa al consumir render, capacidad retenida, eventos y emergencia en ambas rutas. La deduplicación de paquetes reutiliza PCM validado del mismo hash y mantiene pins/conversiones activos contabilizados bajo presupuesto estrecho. No acredita audición ni RSS. Checklist vigente en [PHASE_5.md](../PHASE_5.md); ADR-001 permanece sin cambios: una sola salida por motor.

Validación final de Fase 5 superada: `npm run check` con Node 22.23.3 cacheado, tipos, lint, formato, 233 pruebas frontend en 15 archivos (142 + 91) y build. Rust: 110 correctas (79 + 31), 1 hardware ignorada, formato `--all --check`, Clippy `--all-targets -D warnings` y build Linux con `--locked --offline` donde corresponde. No sustituye la aceptación GUI ni física.

## Corrección: reinicio al repetir un efecto

Por requisito explícito del usuario, el despacho normal de paleta, atajos y diagnóstico reinicia desde cero el mismo efecto, sin superponer copias; efectos distintos siguen mezclándose. Esta decisión sustituye para esos controles la política de cada clic como voz adicional descrita arriba, cuyo historial se conserva. La capacidad multivoz del dominio sigue siendo válida: `play_effect` y `play_effect_with_options` permiten superposición explícita para núcleo, benchmarks y API de bajo nivel, no para los botones normales.

`restart_effect({ effectId, options: PlaybackOptions }) -> playback_id` ejecuta en una sola operación del worker la validación previa y la sustitución. Antes de cortar valida recurso, opciones, volumen por defecto, salida, disponibilidad PCM y cupo. Un rechazo previo conserva las voces del objetivo. El cómputo excluye las voces que se sustituirán: con el límite de 16 lleno se puede reiniciar el efecto propio sin otro cupo, nunca robar voces de otros efectos.

Tras validar, corta todas las voces del mismo `effect_id`, incluidas loop/fade, e inicia una desde el frame cero con ID nuevo, envolvente nueva, volumen por defecto vigente y opciones recibidas. Si falla el driver después del corte, las anteriores quedan retiradas, se muestra el error y los demás efectos continúan. Atomicidad de despacho no implica rollback ni impide instantáneas intermedias de parada. Las compuertas retiradas permanecen cerradas y STOP conserva su barrera; no se pueden retirar buffers ya entregados al SO/hardware.

El alcance es el recurso en todo el motor, no la asignación: dos botones del mismo efecto se reinician entre sí incluso en bancos distintos. No exige migración SQLite ni cambios de opciones por asignación. `NativeAudioController.play` y `playWithOptions` usan `api.restartEffect`, con opciones por defecto o explícitas respectivamente. La demo sigue siendo visual, sin validar audio nativo.

Regresiones: 500 reinicios mantienen una sola voz objetivo y otro efecto activo; colapso de voces superpuestas creadas por API de bajo nivel, límite lleno sin robo, validación que conserva voces, fallo posterior aislado, nuevo volumen/opciones, carreras con STOP y fuente/envolvente real desde frame cero sin revivir la anterior. Validación final: `npm run check:all` superado con Node 22.23.3 y Rust 1.99.1, 266 pruebas frontend en 16 archivos, 122 Rust correctas y 2 ignoradas, rustfmt y Clippy all-targets sin advertencias. `npm run bundle:linux` superado, release Linux y DEB `0.1.0` reconstruidos con la corrección. El paquete sigue sin firma, solo de prueba y no instalado; una instalación anterior no se actualiza automáticamente. Artefacto vigente en [RELEASE.md](../RELEASE.md#artefacto-vigente-con-la-corrección), detalle en [VERIFICATION.md](../VERIFICATION.md#corrección-reinicio-al-repetir-un-efecto). No se realizaron pruebas GUI/audio/hardware para esta corrección. No se altera el historial ni benchmarks, ni se abre otra fase o autoriza publicación.
