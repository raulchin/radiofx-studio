# Fase 3: audio nativo

## Estado y alcance

Fase 3 fue autorizada por el usuario y está implementada. Pruebas automatizadas, controles de calidad y compilación nativa Linux superados; **aceptación manual con hardware pendiente**. No se ha probado aún la GUI Tauri ni el intercambio desde una WebView real. Fase 4 necesita autorización explícita.

El alcance de audio es deliberadamente **tres señales de prueba precalculadas en Rust**, no archivos de producción ni integración de la biblioteca mock. Rodio 0.21.1 usa únicamente `playback`, CPAL 0.16 es transitivo y UUID identifica motor/dispositivos. Cargo.lock está generado. No hay decoder, importación, SQLite, caché LRU, reproducción de archivos largos ni preferencia durable. WAV, MP3, OGG y FLAC siguen siendo objetivos futuros no verificados.

## Implementado

- Una única salida elegida expresamente; no se abre ni reproduce al arrancar. La enumeración de UI no selecciona el dispositivo predeterminado.
- Tokens UUID por enumeración ligados a handles reales: renovar invalida tokens anteriores, pero no cambia el stream ya abierto. Preferencia solo de sesión.
- Cambio controlado: detener voces, cerrar salida, intentar la nueva y recuperar la anterior si falla, sin reanudar voces ni fallback silencioso. Errores y resultado de restauración visibles; `device_error` no se presenta como listo.
- Señales aguda de 450 ms, pulsada de 300 ms y grave de 4000 ms. PCM mono `f32` a 48 kHz, compartido por `Arc`, 912000 bytes de muestras en total, aparte del resto de memoria del proceso.
- Disparos repetidos independientes con `playback_id` únicos. Límite inicial 16, configurable 1..64; rechaza voz 17 sin robo y reducciones por debajo de las voces activas.
- Parada por instancia, por efecto y general; limpieza natural de voces. Maestro atómico, ganancia por instancia y valor por defecto solo para voces futuras, todos finitos 0..1.
- Mezcla común protegida por `0.95 * tanh(x / 0.95)` después del maestro: pruebas de finitud/pico, pero saturación que colorea el audio, no limitador transparente ni aceptación auditiva.
- Worker único propietario, cola normal acotada a 64 y backpressure explícita. Sin I/O, decodificación o logging síncrono de aplicación en el callback.
- Trece comandos y siete eventos con instantánea completa UUID/revisión, validación Zod, reconciliación periódica cada 1500 ms y protección contra consultas/motores obsoletos.
- Panel nativo separado del CRUD demo, sin voces optimistas. Coalescencia de ganancias/límite por control y borrador del límite aplicado por botón o Enter, distinto del confirmado por Rust.
- ACL de trece comandos y escuchar/liberar eventos solo en `main`; sin permiso de emisión frontend. Pruebas de handlers y ACL con contexto de producción generado y runtime/transporte simulados.

## Parada de emergencia

**STOP ALL · audio nativo** y **Ctrl+Shift+Space**, también desde un modal, envían la misma emergencia. El atajo requiere foco en la aplicación, no es global del sistema operativo. La acción de pie **Restablecer demo** solo limpia estados visuales mock.

La emergencia activa directamente un `AtomicBool` que hace entregar cero a la fuente final sin consumir el mezclador. No necesita que el worker avance, ni espacio en la cola, y se prueba con enumeración bloqueada. El worker luego detiene voces y cancela pendientes normales, incluidas consultas y ganancias, con `request_cancelled`; confirma tras drenar. Mientras tanto nuevas admisiones normales reciben `stop_in_progress`. Las paradas concurrentes comparten confirmación.

El corte permanece hasta un nuevo disparo aceptado tras la barrera; consultas, ganancias, límite o selección no lo levantan. Las voces retiradas quedan invalidadas irreversiblemente después del remuestreo, sin reaparición al rearmar. STOP también descarta intenciones frontend de ganancia/límite aún no enviadas; no puede cancelar IPC que ya se envió.

**Corte no es ACK:** un driver bloqueado puede retrasar la confirmación o el cierre. El render independiente sigue cortado, pero no se pueden retirar buffers ya entregados al sistema/hardware. No hay garantía de latencia audible ni mediciones p95.

## Ejecución reproducible

Desde la raíz, con Node 22 compatible, Rust estable/Cargo con rustfmt y Clippy, y bibliotecas nativas Tauri/ALSA instaladas:

```bash
npm ci
npm run tauri dev
```

`npm run dev` sirve solo la UI web; el CRUD mock funciona y el panel informa de la ausencia de Tauri. No reproduce audio nativo. Preparar herramientas/dependencias puede requerir red, no el uso normal.

En este entorno Linux se utilizó Node 22.23.3 temporal y Rust estable 1.99.1 instalado solo bajo `/tmp/opencode`, sin modificar instalaciones globales. Rust sigue ausente del PATH normal. Mientras existan esas rutas:

```bash
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo npm exec --yes --package=node@22 -- npm run tauri dev
```

Este comando es la vía de arranque a probar, no una afirmación de GUI ya ejecutada. Pruebas habituales, sin abrir salida física:

```bash
npm exec --yes --package=node@22 -- npm run check
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo cargo test --locked --manifest-path src-tauri/Cargo.toml
env PATH="/tmp/opencode/cargo/bin:$PATH" RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo cargo build --locked --manifest-path src-tauri/Cargo.toml
```

Con herramientas ya en PATH se omiten los prefijos temporales. No se requiere instalarlas globalmente. El archivo de bloqueo se respeta con `--locked` donde corresponde.

## Verificación registrada

| Comprobación        | Resultado y alcance                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend            | Typecheck, lint, formato, pruebas y build superados; 78 pruebas en 7 archivos con Node 22.23.3.                                                |
| Rust                | 33 pruebas correctas y 1 hardware ignorada; formato, Clippy `--locked --all-targets -- -D warnings` y build `--locked` correctos.              |
| Render sin hardware | PCM, instancias, remuestreo estéreo, finalización, picos, corte con driver bloqueado y no reaparición tras rearme.                             |
| Tauri de prueba     | Handlers/ACL con contexto generado de producción y runtime/transporte simulados; no WebView real.                                              |
| Chrome              | 1440x1000, 390x844 y 320x720; flujo con IPC falso en desktop y 320 px, dos voces del mismo efecto, sin errores/desbordamiento en el recorrido. |
| Hardware/GUI        | No ejecutados; no se abrió salida ni se reprodujo sonido físico en los tests habituales.                                                       |

El test ignorado `explicitly_selected_real_output_opens_without_playing` requiere `RADIOFX_TEST_OUTPUT_NAME` con nombre exacto y coincidencia única; abre y cierra esa salida sin reproducir señales. No se ejecutó y no sustituiría la aceptación audible. No activar `--ignored` indiscriminadamente.

Resultados completos y registros inalterados de las dos primeras fases en [VERIFICATION.md](VERIFICATION.md). Las comprobaciones de compilación Linux eliminan el bloqueo histórico de Cargo, no los pendientes de runtime/hardware. GTK/WebKit y desarrollo ALSA 1.2.11 estaban disponibles; la ausencia histórica de desarrollo librsvg no impidió este build nativo.

## Checklist manual pendiente

Ejecutar fuera de emisión/en antena, con salida elegida y autorizada por el usuario. Comenzar con amplificación física baja y maestro muy bajo; aumentar solo lo necesario. No probar todas las voces a ganancia máxima ni asumir que la saturación numérica garantiza un nivel seguro. Registrar sistema, driver, dispositivo, frecuencia/canales, niveles usados y resultado real.

1. **Arranque GUI:** abrir desktop, comprobar ausencia de audio y salida no seleccionada, sin voces. Verificar que consulta/diagnóstico no abren salida. Confirmar errores de puente o permisos sin estado listo inventado.
2. **Selección explícita:** enumerar y seleccionar el dispositivo autorizado, confirmar `ready` y nombre. Probar cada señal a nivel bajo; aguda 450 ms, pulsada 300 ms y grave 4 s. Verificar que el audio sale solo por esa salida y que las tarjetas mock no suenan.
3. **Instancias:** repetir rápidamente la señal grave de 4 s, comprobar dos IDs distintos, superposición y finalización sin voces fantasma. Detener una y después todas las del efecto, sin afectar otra señal.
4. **Ganancias:** con dos voces, cambiar una sola instancia; cambiar el valor por defecto y comprobar que afecta solo al próximo disparo; comprobar maestro y maestro cero. Evaluar coloración/transitorios a niveles seguros, sin declarar transparencia ni ausencia de clipping por inspección de la UI.
5. **Límite:** aplicar primero un límite pequeño por botón/Enter y comprobar valor confirmado y rechazo sin corte de voces existentes. Con nivel físico/maestro conservador y únicamente si es seguro, disparar la grave repetidamente hasta 16 dentro de sus 4 s e intentar la 17: rechazo visible sin robo. Si terminan antes de alcanzar el límite, repetir controladamente o registrar que la prueba física no se completó. No usar 16 voces a volumen pleno como ensayo inicial.
6. **Emergencia:** durante superposición usar botón y Ctrl+Shift+Space, también dentro de modal/campo. Comprobar silencio y retirada de voces, sin alterar la demo. Consultar/cambiar ganancias o salida tras STOP y comprobar que no vuelve el audio; un disparo nuevo debe sonar sin recuperar voces antiguas. La simulación automatizada ya cubre cola llena y driver bloqueado; no provocar bloqueos peligrosos del driver físico.
7. **Tokens y cambio:** renovar lista, comprobar que no cambia la salida abierta; seleccionar otra salida autorizada y verificar parada previa, sin reanudación. Si puede provocarse un fallo de apertura de forma controlada, comprobar el error y restauración de la anterior; si también falla, salida no disponible sin redirección. No se exige forzar un fallo inseguro para cerrar el recorrido.
8. **USB/desconexión:** a nivel bajo, desconectar la interfaz seleccionada y comprobar error, voces retiradas y ausencia de fallback a altavoces integrados. Reconectar, renovar y seleccionar explícitamente; no debe reanudar audio. Repetir recuperación/restauración física cuando el hardware permita reproducir el caso.
9. **Reconciliación y cierre:** consultar estado durante uso y tras terminar voces; abrir/cerrar ajustes sin duplicar escuchas. Cerrar desktop y comprobar liberación de salida. Reiniciar debe volver sin selección durable ni audio automático en esta fase.
10. **Mediciones:** documentar metodología y medir disparo-audio y STOP-silencio incluyendo buffers, picos/clipping real, calidad audible y CPU/memoria tras cientos de ciclos. Las metas p95 < 50 ms no están verificadas. Registrar pruebas por plataforma; Linux no acredita Windows/macOS.

También quedan pendientes IPC real de WebView/CSP, auditoría de accesibilidad con lector de pantalla, instaladores e identidad/iconos para distribución. Una comprobación visual Chrome no sustituye ninguna de estas pruebas.

## Módulos afectados

La implementación de Fase 3 abarca `src-tauri/Cargo.toml` y `Cargo.lock`, dominio `domain/audio.rs`, aplicación `engine.rs`, `worker.rs` y tests, infraestructura `audio.rs`, commands y pruebas IPC, composición `lib.rs`, registro `build.rs` y capability. En frontend afecta contratos/adaptador de audio, controlador/hook/panel nativo, App, ajustes, pie demo y estilos; las pruebas residen en `tests/` e internos Rust. No implica que todos esos archivos se modifiquen en cada revisión documental.

Documentación vigente: README, ARCHITECTURE, AUDIO_ENGINE, ROADMAP, VERIFICATION y ADR-001/002/003. PHASE_2 y registros de Fases 1/2 se mantienen históricos; ADR-004 sigue describiendo datos locales futuros.

## Puerta de aprobación

Implementación entregada, automatización y compilación Linux verificadas; aceptación física pendiente de completar o aceptar explícitamente con sus limitaciones. **Se solicita autorización expresa antes de iniciar Fase 4.** No conectar aún CRUD mock a archivos, añadir SQLite/importadores ni presentar preferencias de sesión como persistencia durable.
