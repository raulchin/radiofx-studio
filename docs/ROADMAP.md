# Plan de desarrollo

## Regla de avance

Fase 1 está aceptada por el usuario; Fases 2, 3, 4 y 5 fueron autorizadas y están implementadas. **Fase 6 también está autorizada**, con validación automatizada Linux y paquete DEB de prueba superados, pero no cerrada. La aceptación física y los recorridos manuales desktop siguen pendientes. La publicación continúa bloqueada y no se realiza automáticamente.

La aceptación de Fase 1 conserva los bloqueos históricos de validación nativa y no se reabre. Las secciones siguientes de Fases 1 a 5 describen aquellas entregas, no toda la evidencia actual. El registro está en [VERIFICATION.md](VERIFICATION.md). Fase 6 añade arranque/reapertura desktop Linux en perfil aislado; no valida interacción completa ni sonido físico.

## Fase 1: base y arquitectura

Base implementada: Tauri 2, React 19, TypeScript 6 estricto, Vite 8, Tailwind CSS 4 y Zod 4, con pantalla de arranque y consulta tipada sin reproducción real.

- Dominio en `domain/audio.rs`, caso de uso de consulta, DTOs serializables en infraestructura y comando `get_audio_engine_status`.
- Frontend en `src/app/App.tsx`, contratos y adaptadores en `src/shared/`, y estilos en `src/styles/global.css`.
- Validación de la respuesta IPC `unknown` mediante Zod estricto: `not_initialized`, dispositivo nulo, ninguna reproducción y límite 16.
- Zustand y shadcn/ui sin instalar; sin motor real ni crates de SQLite.
- Arquitectura, diseño de audio y cuatro ADR documentados.
- ESLint 10, Prettier 3 y Vitest 5 incorporados, con scripts `typecheck`, `lint`, `format`, `format:check`, `test`, `test:watch`, `check` y `build`.
- CSP local de producción y `devCsp` con localhost, plugin opener eliminado y única capability `allow-get-audio-engine-status` para `main`. `build.rs` declara el comando mediante `AppManifest::commands` para autogenerar la ACL durante el build.

Resultados comunicados: typecheck y lint superados, 7 pruebas TypeScript pasando y build frontend correcto con Node 22.23.3 temporal. La instalación npm informó 0 vulnerabilidades en su auditoría. Estos resultados validan las comprobaciones frontend indicadas, no la aplicación nativa ni toda la seguridad del producto.

La cadena completa `npm exec --yes --package=node@22 -- npm run check` pasó: tipos, lint, formato, 7 pruebas y build frontend. La validación nativa sigue pendiente.

Bloqueos nativos: `cargo fmt`, `cargo clippy` y `cargo test` se intentaron y fallaron porque Cargo no está disponible. Tauri info indica Rust, rustup, Cargo y `rsvg2` ausentes; las bibliotecas GTK/WebKit están presentes. Node 18 del entorno es incompatible, por lo que se utilizó Node temporal para frontend. No se ha acreditado compilación Rust, funcionamiento de la ACL generada, arranque desktop ni pruebas manuales.

Fase 1 fue aceptada con esos bloqueos registrados; no se declara validación nativa integral. Se conservan el identificador `com.chinlabsgroup.radiofx-studio` y los iconos de plantilla, con revisión pendiente antes de distribuir. Los prerrequisitos nativos no se han vuelto a comprobar durante Fase 2.

## Fase 2: paleta visual

Autorizada por el usuario e implementada sin motor real. Guía y alcance en [PHASE_2.md](PHASE_2.md).

- Store Zustand 5, coordinador de formularios y errores, modelos Zod y repositorio síncrono versión 1 en memoria, con validación y copias.
- CRUD y orden de bancos y botones; nombres, categoría, seis colores y duración mock. Identidad de asignación independiente del efecto; nuevos botones sin archivo.
- Cuatro estados demo separados del motor; contador de botones, volumen visual y `STOP ALL` sobre todos los bancos, incluidas pausas y errores.
- DnD nativo y controles antes/después para teclado y toque; diálogo nativo con gestión de foco y Escape; columnas automáticas/3/4/6 adaptables al ancho.
- Diagnóstico nativo conservado en Configuración, sin cambios en adaptador, contratos de audio, Rust ni capabilities. Sin dependencias DnD/UI adicionales ni persistencia al recargar.
- 50 pruebas en 4 archivos, typecheck, lint y build superados individualmente con Node 22.23.3 temporal; Chrome web revisado a 1440×1000, 390×844 y 320×720. No acredita Tauri ni Windows/macOS.

Comprobación conjunta y registro de resultados completados. Se espera autorización explícita para Fase 3; no se inicia audio nativo en esta entrega.

## Fase 3: audio nativo

Autorizada e implementada. Alcance, módulos y checklist en [PHASE_3.md](PHASE_3.md).

- Rodio 0.21.1 con `playback`, CPAL 0.16 transitivo, UUID y Cargo.lock generado. Tres señales PCM precalculadas, no archivos de producción ni decodificadores.
- Una salida seleccionada explícitamente, sin apertura al arrancar; tokens renovados por enumeración, recuperación controlada de salida anterior y errores sin fallback silencioso.
- Instancias independientes del mismo efecto; límite inicial 16 configurable 1..64, rechazo visible sin robar voces; ganancias finitas de maestro, instancia y valor por defecto para voces futuras.
- Cola normal de 64 y STOP de emergencia fuera de ella: corte atómico del render aun con worker bloqueado, cancelación de pendientes y confirmación posterior. Compuertas irreversibles impiden revivir voces antiguas; solo un disparo nuevo aceptado rearma.
- Protección común mediante saturación suave `0.95 * tanh(x / 0.95)`, validada numéricamente, no un limitador transparente ni aceptación auditiva.
- Trece comandos y siete eventos de instantánea completa con UUID/revisión, frontend validado con Zod, reconciliación por consulta/polling y panel nativo separado del CRUD mock.
- Comprobaciones frontend superadas: 78 pruebas en 7 archivos. Rust: 33 correctas, 1 hardware ignorada; formato, Clippy y build Linux correctos. Prueba de handlers/ACL Tauri con contexto de producción generado y transporte/runtime simulados, no WebView real.

**Aceptación pendiente:** arranque GUI y salida física seleccionada por el usuario, dispositivos USB/cambio/restauración, calidad audible y clipping real, latencias y estabilidad de recursos medidas. Chrome y el IPC simulado no cubren hardware. Una llamada bloqueada del driver puede retrasar ACK/shutdown; el corte no depende del worker, pero no retira buffers del hardware ni garantiza latencia. La preferencia solo vive en sesión; su persistencia durable y resolución al reiniciar corresponden a Fase 4.

La puerta anterior se conserva como antecedente: Fase 4 fue autorizada posteriormente, sin convertir los pendientes físicos de Fase 3 en pruebas realizadas.

## Fase 4: biblioteca y datos

Autorizada e implementada. Guía, inventario y aceptación en [PHASE_4.md](PHASE_4.md).

- SQLite bundled con rusqlite 0.40.2, migración 001 transaccional y `user_version=1`, FK/restricciones e integridad; rechazo de versiones futuras/esquemas desconocidos sin reset. Principal vacío en una instalación nueva, sin migrar mocks volátiles anteriores.
- Biblioteca y copias gestionadas con rutas relativas, SHA-256 y deduplicación; originales intactos. Reparación por reimportación con archivo UUID nuevo, sin cambiar identidad/asignaciones ni borrar el archivo antiguo. Limpieza limitada a copias nuevas propias no confirmadas; huérfanos conservados.
- Selector nativo Rust, Symphonia 0.5.5 y fixtures reales WAV PCM, MP3, OGG Vorbis y FLAC, sin prometer todas las variantes. Límites explícitos de archivo, PCM, duración y catálogo, precarga completa acotada, no streaming ni LRU.
- Producción `PersistentStudio`, hook separado y controlador IPC asíncrono de estado confirmado; errores/conflictos visibles y recarga sin sobrescritura. Demo solo en navegador, nunca fallback de un error SQLite. Edición y orden existentes ahora durables, sin ampliar herramientas profesionales de Fase 5.
- Revisión optimista solo para tablero, preferencias por UPDATE de campo y lecturas SQL frescas/transaccionales coherentes entre dos instancias. No sincroniza los motores de audio de distintos procesos.
- Configuración durable: banco activo, columnas, maestro, límite, valores por defecto y nombre de salida preferido. Resolución como sugerencia con confirmación explícita, jamás autoapertura/fallback. I/O/decoder fuera del worker y callback; adaptación CPU en worker, compartida y presupuestada.
- Corrección final de pins de conversiones obsoletas y revalidación de hasta dos pases, conservando memoria activa contabilizada. STOP seguido de refresco recupera recursos sin reselección cuando se liberan las voces; backpressure de 128 fuentes si el render no consume.
- Diecisiete comandos más escuchar/liberar eventos, sin rutas IPC ni permisos generales de archivos. Pruebas de handlers/ACL con runtime simulado, no WebView real.
- Verificaciones finales correctas: `npm run check`, 142 frontend (78 + 64), formato Rust, Clippy, 79 Rust (33 + 46) y 1 hardware ignorada, build nativo Linux. Ambas cadenas se repitieron correctamente al cerrar la implementación. Chrome con APIs falsas en 1440x1000, 390x844 y 320x720, sin errores/desbordamiento.

**Aceptación provisional, manual pendiente:** selector nativo, importación/asignación/reinicio durable desde GUI y WebView real, perfil de datos aislado, originales seguros, fallos y recuperación; además de hardware, USB, calidad/latencias y plataformas pendientes de Fase 3. No se usaron datos reales de usuario ni se ejecutó el diálogo nativo. Los resultados automatizados no equivalen a E2E nativo completo.

La puerta de Fase 4 se conserva como antecedente: Fase 5 fue autorizada posteriormente, sin convertir los pendientes manuales de Fases 3/4 en pruebas realizadas. PHASE_4 y su registro de verificación permanecen intactos.

## Fase 5: funciones profesionales

Autorizada e implementada en código de producto, UI y pruebas. Guía, inventario y aceptación en [PHASE_5.md](PHASE_5.md).

- Tablero de producción v2, demo v1 intacta; migración SQLite 002 transaccional IMMEDIATE, sin modificar 001, con validación de versión/tablas antes del DDL sobre bases existentes. Opciones por botón y atajos durables.
- Atajos físicos configurables de aplicación/banco para disparar, seleccionar banco y STOP; máximo 512, referencias y conflictos validados en Rust/TypeScript. Un listener raíz y último ACK; emergencia reservada también en campos/modales. Solo aplicación enfocada, no hotkeys del sistema.
- Loop sobre PCM adaptado compartido, sin copias por vuelta; desactivarlo termina la vuelta actual. Fades 0..30000 ms sobre frames consumidos, entrada una vez y salida explícita irreversible, manteniendo capacidad hasta retirarse. Paradas y dispositivo cortan sin fade. Sin crossfade ni afirmación gapless/hardware.
- Búsqueda local sin acentos/mayúsculas en paleta/biblioteca; filtro no cambia orden/recuentos durables, y desactiva ordenación en filtro/multibanco. Copia de asignación con ID nuevo sin audio/atajos duplicados; mover avisa y elimina sus atajos de disparo atómicamente.
- Paquetes `.rfxbank` formato 1: codec manual ZIP Stored deliberadamente cerrado, no ZIP genérico; manifiesto/CRC/hash/decoder y límites de 256 MiB, 2 MiB de manifiesto, 256 audios/257 entradas. Sin nuevas dependencias runtime. Vista previa con token único de proceso, diez minutos de caducidad perezosa, cancelación incluso de respuesta tardía y commit completo por revisión; añade bancos/IDs, no sobrescribe. Atajos deshabilitados salvo opt-in, deduplicación conserva valores locales y PCM validado compartido.
- Exportación a destino nuevo mediante temporal exclusivo sincronizado y hardlink sin reemplazo; filesystem sin hardlinks devuelve error visible, nunca fallback inseguro. Error postcommit exige recarga sin reimportar automáticamente; registro sin autoplay/rearme STOP.
- Validación final superada: `npm run check` con Node 22.23.3 cacheado, tipos, lint, formato, 233 pruebas frontend en 15 archivos (142 + 91) y build, incluidas las regresiones Unicode. Rust: 110 correctas (79 + 31) y 1 hardware ignorada; formato `--all --check`, Clippy `--all-targets -D warnings` y build Linux correctos con `--locked --offline` donde corresponde. Ambas cadenas finales están superadas. Se conservan las pruebas previas con fixtures ajustadas al contrato v2, sin fallback de producción v1.
- Chrome con APIs falsas a 1440x1000, 390x844 y 320x720: atajos, búsqueda, paquetes/vista previa, modales, loop/fade y STOP sin errores JavaScript ni desbordamiento. No es GUI Tauri ni WebView/SQLite reales.

**Aceptación manual pendiente:** copia de seguridad con todas las instancias cerradas, migración desde v1 poblada en perfil aislado, reinicio de opciones/atajos, selectores/IPC reales, conflictos y cancelación, exportación existente rechazada, atomicidad sobre paquetes inválidos, escucha de loops/fades y emergencia. Se mantienen los pendientes físicos/multiplataforma anteriores. Completar o aceptar explícitamente estas limitaciones y solicitar autorización antes de Fase 6.

## Fase 6: validación y distribución

Autorizada y parcialmente validada. Guía en [PHASE_6.md](PHASE_6.md), distribución en [RELEASE.md](RELEASE.md) y aceptación en [HARDWARE_TESTS.md](HARDWARE_TESTS.md).

- Calidad local Linux: 264 pruebas frontend en 16 archivos y 116 Rust correctas, 2 ignoradas; tipos, lint, formato y Clippy all-targets superados. El recuento principal inicial de 254 precede a diez regresiones finales verificadas independientemente.
- Scripts de calidad offline/locked, benchmark release opt-in y preflight de versiones/identidad/CSP/ACL; no nuevos servicios runtime ni ampliación de permisos.
- Benchmark software del mezclador real sin CPAL: 1/16/64 voces, ACK/corte separados y 500 ciclos con recursos propios liberados; no latencia audible ni prueba de estabilidad RSS.
- DEB Linux sin firma generado e inspeccionado sin root, desktop entry válido y dependencias locales resueltas; no instalado, actualizado ni desinstalado. Baseline conservador glibc >= 2.39.
- Proceso release iniciado y reabierto con perfil XDG temporal, ventana y SQLite v2 comprobadas; no E2E WebView/selector, ni cierre normal validado.
- Configuraciones NSIS y app/DMG y workflows multiplataforma preparados, no ejecutados remotamente ni validados en Windows/macOS. Icono propio provisional, identificador/versiones conservados.

**Publicación bloqueada:** licencia, titular/publisher, identidad final, firmas/notarización, plataformas, instalación y aceptación desktop/hardware pendientes. Las metas de latencia audible p95 < 50 ms, clipping físico y estabilidad prolongada de recursos aún requieren medición. Fase 6 es la fase final prevista: el siguiente paso es la decisión legal y de aceptación del titular, no inventar otra fase ni publicar automáticamente.

## Puerta de cierre

Antes de cerrar cada fase se exige:

1. Resumen de lo implementado y de lo pendiente, con archivos afectados.
2. Comandos ejecutados y resultados reales, incluidos fallos y bloqueos del entorno.
3. Pruebas automáticas y manuales realizadas y pendientes, por plataforma cuando corresponda.
4. Documentación y ADR actualizados si cambian las decisiones.
5. Riesgos residuales explícitos y solicitud de autorización antes de avanzar.

Quedan fuera del MVP salvo autorización: múltiples salidas, preescucha independiente, streaming, nube, cuentas, MIDI, automatizadores de radio, editor avanzado de ondas y marketplace.
