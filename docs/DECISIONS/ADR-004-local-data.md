# ADR-004: funcionamiento offline y datos locales

## Estado

Decisión aceptada e implementada en Fases 4/5 autorizadas: SQLite local, migraciones y copias gestionadas, ahora con opciones, atajos y paquetes de bancos. Automatización y build Linux correctos; aceptación desktop/manual pendiente. Fase 6 requiere autorización. Los alcances históricos se conservan en VERIFICATION y PHASE_2/3/4.

## Contexto

La aplicación debe funcionar offline durante el uso normal, sin cuentas ni servicios externos obligatorios. Los archivos externos pueden moverse, desaparecer o perder permisos, y los paquetes de bancos constituyen entradas no confiables.

## Decisión de almacenamiento

`rusqlite 0.40.2` con SQLite bundled abre `app_data_dir/library.sqlite3`. La migración 001 permanece inmutable y 002 lleva a `user_version=2`. En transacción IMMEDIATE se consulta versión y, sobre una base existente, se compara el esquema de tablas con la versión declarada antes del DDL. Se comprueba de nuevo el esquema final, integridad y referencias antes del commit. No es una auditoría universal de triggers/otros objetos SQL. Una versión futura se rechaza sin migrar/resetear sus datos. Una base nueva contiene Principal vacío. No había datos persistidos pre-Fase 4: los mocks en memoria no se migran. Respaldar con todas las instancias cerradas, especialmente clientes v1, y validar en perfil aislado.

Tablas implementadas: `sound_effects`, `sound_banks`, `bank_effects`, `categories`, `app_settings`, `diagnostic_volumes` y `keyboard_shortcuts`. Guardan metadatos, duración real, formato, ruta relativa/hash, ganancias predeterminadas, asignaciones/posiciones/opciones de reproducción, atajos, categorías, banco activo, columnas, maestro, límite y nombre preferido de salida. No se guardan bytes de audio, PCM o voces en SQLite. Tablero de producción v2; demo v1 separada e intacta.

Los archivos se eligen mediante `tauri-plugin-dialog 2.8.3` desde Rust: IPC no recibe rutas, y JS no dispone de filesystem genérico ni comandos directos del plugin. Cada importación crea una copia exclusiva `audio/<uuid>.bin` y guarda la ruta relativa; el original nunca se modifica ni elimina ni se usa como referencia persistente. SHA-256 con `sha2 0.11.1` identifica duplicados de bytes.

Si la copia gestionada falta o fue alterada, reimportar bytes sanos del mismo hash la repara mediante **otro UUID de archivo**. Conserva efecto, asignaciones, nombre y volumen, devuelve `duplicate: true` y no sobrescribe ni borra la entrada vieja. Importaciones parciales confirman cada recurso aisladamente y muestran cancelación, duplicados y errores. Ante fallo antes del commit, SQL revierte y RAII limpia solo la copia nueva propia. Un fallo posterior al commit se informa como parcial, no como rollback ficticio. Huérfanos inesperados se conservan; no hay comando de borrado de archivos de biblioteca en Fase 4 y el coste en disco puede crecer.

`cap-std/cap-fs-ext 4.0.3` fijan los padres por descriptor, sin seguir enlaces en cada componente; apertura final nofollow/nonblock y comprobación de archivo regular rechazan symlinks/FIFO. La copia usa `create_new` exclusivo y el mismo directorio fijado incluso para limpieza. No se usa `unsafe` propio. SQLite se abre por separado con NOFOLLOW y comprobaciones de enlaces/sidecars: se presupone una raíz privada de aplicación, no protección universal frente a carreras TOCTOU o procesos con escritura sobre ella.

El tablero usa control optimista con revisión SQL real y transacción. Preferencias actualizan solo el campo solicitado, preservando cambios de otro proceso. La recarga obtiene todas las tablas bajo una transacción de lectura coherente. Esto cubre dos instancias compartiendo datos, no sincronización global del audio: cada instancia mantiene motor y stream propios conforme a ADR-001. El frontend publica ACKs, muestra conflictos y recarga sin reenviar una edición obsoleta.

Maestro, límite y volúmenes predeterminados se aplican al motor y luego se guardan fuera del worker; un fallo de persistencia comunica que el audio ya cambió. Solo se conserva el nombre del dispositivo: coincidencia única como sugerencia con confirmación explícita; ausente o ambiguo sin fallback. No se abre ninguna salida al iniciar.

Symphonia 0.5.5 verifica extensión/firma/decoder para WAV PCM, MP3, OGG Vorbis y FLAC; no Opus ni garantía de todas las variantes. Límites de 32 MiB archivo/PCM por recurso, 120 s, 1..2 canales, 8..192 kHz, 4096 efectos y 256 por importación. La precarga completa comparte Arc con presupuesto PCM total 128 MiB (diagnósticos y reserva 32 MiB de adaptación incluidos), no es LRU, streaming ni límite RSS. Disco/hash se revalidan al iniciar/refrescar/importar, no continuamente. Pins/conversiones activas permanecen presupuestados; la sincronización libera conversiones ociosas obsoletas y reintenta como máximo una vez. Detalles en [AUDIO_ENGINE.md](../AUDIO_ENGINE.md).

## Seguridad de paquetes

Fase 5 implementa `.rfxbank` formato 1 con un **codec manual mínimo y cerrado ZIP Stored** en `bank_archive.rs`. Se implementó, revisó y probó este subconjunto: no se afirma compatibilidad ZIP genérica. No se añadió crate ZIP ni dependencia runtime; la red no estaba disponible y la fuente de un crate ZIP no estaba cacheada. La restricción se hace explícita, no se simula una dependencia.

- Máximos: paquete 256 MiB, `manifest.json` 2 MiB, 256 audios/257 entradas; cada audio respeta además los límites del decoder y presupuesto PCM de biblioteca.
- Manifiesto estricto con `format: "radiofx-bank"`, `formatVersion: 1`, `banks: SoundBank[]`, `resources: { hash, name, format, defaultVolume }[]` y `keyboardShortcuts` opcional. Los `effectId` internos refieren hashes; duración se comprueba contra decoder. No incluye SQL, rutas locales, maestro, salida ni diagnósticos nativos.
- Solo nombres ASCII exactos `manifest.json` y `audio/<sha256 minúsculo>.<wav|mp3|ogg|flac>`. Sin extracción de nombres a disco. Rechaza traversal, barras inversas, duplicados/colisiones de caso, enlaces y tipos especiales, extras, ZIP64, cifrado, compresión, descriptores de datos, comentarios y multidisco.
- Comprueba coherencia de cabeceras/directorio y CRC, hash SHA-256 y formato/PCM real. Puede reutilizar PCM del mismo hash/formato/tamaño previamente validado; lo demás se decodifica bajo presupuesto, contando pins activos y preparación pendiente sin contar dos veces un Arc compartido. CRC/hash aportan integridad, no autenticidad.
- Preparación por selector Rust con vista previa; una lease `IMPORT_PENDING` atómica global al proceso se libera por Drop. Una sola preparación pendiente, diez minutos de caducidad perezosa al acceder a biblioteca, sin temporizador autónomo. Cancelar/Escape/X/desmontaje libera también tokens de respuestas tardías.
- Commit por `expectedRevision`, en una transacción para todos los recursos, bancos, botones, opciones y atajos. Añade identidades nuevas, nunca sobrescribe bancos existentes; deduplica recursos por hash conservando nombre/defaults locales con aviso. Si la copia gestionada está dañada, usa otro UUID de archivo y preserva identidad de efecto y archivo anterior. Atajos importados deshabilitados por defecto; el opt-in no activa los que venían deshabilitados y un conflicto rechaza toda la operación antes de confirmar datos.
- Un conflicto previo conserva el token en backend; el frontend lo cancela, recarga y exige preparar de nuevo. Tras aceptar el token se consume incluso ante fallo. Rollback limpia solo archivos nuevos propios no confirmados. Un fallo posterior al commit se comunica como parcial y exige recarga, no reimportación automática. Registro sin autoplay ni rearme STOP.
- Exportación desde una captura coherente validada por revisión, con selección de bancos y atajos opcionales. Escribe temporal exclusivo en directorio fijado, sincroniza sus bytes y publica con hardlink **sin reemplazo**. Rechaza un destino existente incluso si el selector confirma sobrescritura; no usa `exists` seguido de rename. Si el filesystem no admite hardlinks devuelve error visible, sin fallback inseguro. Limpia solo el temporal propio.
- Nunca ejecuta scripts ni shell del paquete. Exportar conserva recursos leídos y ZIP codificado simultáneamente, cada conjunto acotado por 256 MiB; ese límite no es garantía RSS del proceso.

Los límites son controles implementados y probados, no una certificación universal de seguridad ni un formato intercambiable con cualquier herramienta ZIP. Selectores y filesystem reales por plataforma siguen pendientes de aceptación manual.

## Consecuencias

- El uso normal no requiere red, pero preparar dependencias y herramientas de desarrollo puede requerirla.
- Copiar y conservar huérfanos consume espacio adicional; capacidad y permisos pueden causar fallos visibles.
- Migraciones y fallos parciales tienen pruebas temporales; no se ejecuta SQL destructivo sobre datos de usuario. Antes de futuras migraciones, respaldar un almacén cerrado y trabajar sobre una copia aislada.
- No se añaden servicios de nube, cuentas ni telemetría sin consentimiento y autorización.

## Validación y pendientes

Pruebas con SQLite temporal y fixtures reales conservan reapertura, referencias, conflictos, dos instancias, deduplicación/reparación, originales intactos y controles de archivos. Fase 5 añade migración poblada v1 a v2, rechazo previo de esquema/versión, roundtrip ZIP cerrado y paquetes maliciosos, CRC/hash/decoder, presupuesto/pins/deduplicación PCM activa, atomicidad, tokens/cancelación, opt-in/conflictos y destino existente sin reemplazo. No se toca `app_data_dir` real. Resultados finales: 110 Rust correctas (79 + 31) y 1 hardware ignorada; `npm run check` con Node 22.23.3 cacheado superado, incluidos tipos, lint, formato, 233 pruebas frontend en 15 archivos (142 + 91) y build. Formato Rust `--all --check`, Clippy `--all-targets -D warnings` y build Linux superados con `--locked --offline` donde corresponde; históricos intactos en VERIFICATION.

La validación final incluye 16 pruebas Unicode: `codePointString` cuenta puntos de código y `.regex(/\P{White_Space}/u)` alinea nombres de producción e IDs de atajos con `trim` de Rust, incluido FEFF, que no debe rechazarse mediante el criterio JavaScript `\S`. No cambia la política de controles de contenido.

Pendientes: selector nativo, migración/reinicio durable desde WebView real, disco lleno real y permisos/hardlinks por plataforma, hardware, Windows/macOS e instaladores. Los paquetes siguen fuera del alcance histórico de Fase 4, pero están implementados en Fase 5. Lista manual segura en [PHASE_5.md](../PHASE_5.md); evidencia y recuentos históricos en [VERIFICATION.md](../VERIFICATION.md). Fase 6 no iniciada.
