# AGENTS.md — RadioFX Studio

> Instrucciones permanentes para agentes de IA que trabajan en este repositorio con OpenCode.
> Este archivo define el contexto, las decisiones arquitectónicas y los criterios de calidad.
> **No es un script ejecutable**: OpenCode debe leerlo y cumplirlo al recibir una tarea.

## 1. Rol y objetivo

Actúa como arquitecto y desarrollador senior especializado en aplicaciones desktop multiplataforma, Tauri 2, Rust, React, TypeScript y audio digital.

**Producto:** RadioFX Studio, una paleta profesional de efectos de sonido para radio, podcasts, streaming y eventos, inspirada funcionalmente en las botoneras radiales, pero con identidad visual y código propios.

**Plataformas objetivo:** Linux, Windows y macOS. La aplicación debe funcionar **100 % offline** durante su uso normal, sin cuentas ni servicios externos obligatorios.

**Principios:** estabilidad en cabina, respuesta rápida al pulsar, accesibilidad, mantenibilidad, mínimo privilegio, pruebas verificables y simplicidad. No introducir microservicios, API REST ni backend remoto para el funcionamiento local.

## 2. Stack aprobado

- Shell desktop: **Tauri 2**, con comandos y eventos entre frontend y backend.
- Frontend: **React + TypeScript estricto + Vite**.
- Estilos: **Tailwind CSS**; componentes **shadcn/ui** cuando aporten valor.
- Estado: **Zustand**; distinguir estado de UI de estado autoritativo del motor.
- Validación frontend: **Zod** en límites de entrada y configuraciones.
- Backend y motor de audio: **Rust**, evaluando **Rodio** y **CPAL** según versiones estables compatibles.
- Persistencia local: **SQLite** con migraciones versionadas.
- Pruebas: **Vitest** para TypeScript/React y `cargo test` para Rust; pruebas de integración y manuales de hardware donde corresponda.
- Formato y calidad: rustfmt, Clippy, ESLint, Prettier y TypeScript `strict`.

Antes de instalar dependencias, comprobar versiones y APIs disponibles en el proyecto. **No inventar métodos o características de crates ni afirmar compatibilidad sin verificarla.** Si no hay acceso a Internet, señalar los puntos no verificados.

## 3. Decisiones arquitectónicas innegociables

### ADR-001 — Una sola salida de audio

- El usuario puede enumerar y seleccionar **un único dispositivo de salida activo**: tarjeta integrada, interfaz USB u otro dispositivo admitido por el sistema operativo.
- Mezclar todos los efectos en ese único dispositivo; **no abrir un stream de salida por botón o efecto**.
- Persistir la preferencia del dispositivo. No asumir que IDs/nombres de dispositivos son estables entre reinicios: implementar resolución y fallback explícito.
- Si el dispositivo desaparece o deja de funcionar, reportar error visible y preservar la estabilidad. No cambiar silenciosamente la salida en una transmisión.
- Para una primera versión, cambiar el dispositivo con una transición controlada: detener reproducciones, intentar abrir la nueva salida y recuperar la anterior si es posible. Informar claramente si no puede restaurarse.

### ADR-002 — Mezcla simultánea

- Pueden sonar **varios efectos distintos simultáneamente**. Por petición explícita del usuario, cada pulsación de un botón o atajo **reinicia su sonido desde el principio**, deteniendo las instancias anteriores del mismo `effect_id` mediante una operación atómica en Rust, sin afectar a otros efectos. La capacidad de superposición explícita del mismo efecto queda limitada a las API de bajo nivel, no al disparo normal de la interfaz.
- Diferenciar `effect_id` (recurso del catálogo) y `playback_id` (instancia concreta de reproducción).
- Límite inicial: **16 instancias concurrentes configurable**; definir comportamiento explícito y visible cuando se alcanza el límite (no cortar sonidos arbitrariamente).
- Soportar `STOP ALL`, detener una instancia, detener todas las instancias de un efecto y volumen individual y maestro.
- Evitar clipping de mezcla y prever un control seguro de nivel/limitación de picos validado con pruebas auditivas y técnicas.

### ADR-003 — Backend propietario del estado de audio

- **Rust es la fuente de verdad** del dispositivo elegido y las reproducciones activas.
- React solo presenta información y envía comandos; no reproducir audios de producción mediante `HTMLAudioElement` ni duplicar en React la lógica de mezcla.
- Comandos Tauri para solicitudes; eventos tipados para cambios de estado. Un evento perdido no debe impedir reconciliar el estado mediante consulta explícita.
- Nunca bloquear el hilo/callback de audio con disco, SQLite, decodificación pesada, logging síncrono, red o trabajo de UI.

### ADR-004 — Offline y datos locales

- SQLite conserva metadatos y configuración; los archivos de audio se gestionan en almacenamiento local con rutas robustas.
- Definir explícitamente si cada archivo se copia al almacén de la app o se referencia externamente; manejar cambios, duplicados, inexistencia y permisos.
- Cambios de esquema mediante migraciones y compatibilidad de datos.
- Imports/exports de bancos deben ser seguros: validar rutas, tipos, tamaño y entradas de archivos empaquetados; evitar traversal y sobrescrituras no autorizadas.

## 4. Arquitectura por capas y funcionalidades

Mantener separación clara:

1. **Presentación (`src/`)**: vistas, componentes, interacción y estado visual.
2. **Aplicación (`src-tauri/src/application/`)**: casos de uso, coordinación de operaciones y reglas de flujo.
3. **Dominio (`src-tauri/src/domain/`)**: entidades, invariantes, errores y contratos.
4. **Infraestructura (`src-tauri/src/infrastructure/`)**: audio, SQLite, sistema de archivos y dispositivos.
5. **Adaptadores Tauri (`src-tauri/src/commands/`)**: comandos, validación de límites y emisión de eventos.

Estructura orientativa (ajustable justificadamente, sin crear carpetas vacías por obligación):

```text
radiofx-studio/
├── AGENTS.md
├── README.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── AUDIO_ENGINE.md
│   ├── ROADMAP.md
│   └── DECISIONS/
├── src/
│   ├── app/
│   ├── components/ui/
│   ├── features/
│   │   ├── soundboard/
│   │   ├── sound-banks/
│   │   ├── sound-library/
│   │   ├── audio-controls/
│   │   ├── keyboard-shortcuts/
│   │   └── settings/
│   ├── shared/
│   └── styles/
├── src-tauri/
│   ├── capabilities/
│   └── src/
│       ├── lib.rs
│       ├── commands/
│       ├── application/
│       ├── domain/
│       └── infrastructure/
│           ├── audio/
│           ├── database/
│           └── filesystem/
└── tests/
```

Reglas de dependencias: presentación -> contratos/adaptadores; adaptadores -> aplicación -> dominio; infraestructura implementa interfaces definidas hacia adentro. Evitar que el dominio dependa de Tauri, React o SQLite. No crear una abstracción sin necesidad real.

## 5. Requisitos funcionales iniciales

- Cuadrícula de botones con nombre, color, estado de reproducción y acción clara; diseño optimizado para pantallas desktop.
- Bancos de efectos y categorías configurables; reordenar botones y editar asignaciones.
- Biblioteca local de sonidos; importar como objetivo **WAV, MP3, OGG y FLAC**, confirmando soporte real en versiones elegidas y mostrando errores ante formatos inválidos.
- Disparar efectos inmediatamente al hacer clic; reiniciar el mismo efecto al repetir la pulsación y permitir simultaneidad entre efectos distintos.
- Detener por `playback_id`, por `effect_id` o todos (`STOP ALL`).
- Volumen maestro y volumen por efecto/instancia, con comportamiento documentado.
- Selección de dispositivo de salida único, guardada en configuración.
- Atajos de teclado configurables con prevención de conflictos; `STOP ALL` accesible siempre por teclado.
- Persistencia local de bancos, botones, configuración y biblioteca.
- Estado de carga, reproducción, error y dispositivo claramente visibles. UI usable por teclado y contraste accesible.
- No incluir funciones que exijan conexión, registro ni telemetría sin consentimiento.

**Fuera del MVP salvo autorización:** reproducción por varias salidas, preescucha independiente, streaming, sincronización cloud, cuentas, integraciones con automatizadores de radio, control MIDI, editor avanzado de ondas y marketplace.

## 6. Diseño del motor de audio

Módulos conceptuales:

- `AudioEngine`: ciclo de vida, coordinación y estado general.
- `DeviceManager`: enumeración, selección, recuperación y errores de dispositivos.
- `PlaybackManager`: mapa de reproducciones activas, IDs y límites de concurrencia.
- `Mixer`: mezcla hacia un solo stream de salida y ganancia segura.
- `AudioCache`: precarga de efectos cortos con presupuesto de memoria/LRU; audio largo mediante streaming cuando sea viable.
- `AudioEvents`: eventos de inicio, parada, fin, error y dispositivo.

**Reglas:**

- No abrir streams independientes por efecto.
- No bloquear callbacks críticos de audio ni retener mutexes durante I/O.
- Mantener vivos los recursos necesarios para la reproducción mientras existan instancias.
- Diseñar política explícita para clics repetidos, archivo corrupto, efecto ausente, error de decodificación y saturación del límite de voces.
- Eliminar instancias finalizadas sin fugas de memoria ni acumulación de handles.
- Emplear nombres de identificadores de dispositivo apropiados para cada backend: si no son persistentes, guardar metadatos y resolver de nuevo al iniciar.
- Cualquier afirmación de baja latencia debe medirse en hardware real, no inferirse del framework.

### Contrato de comandos previsto

Usar DTOs tipados, errores serializables y validación de valores. La firma exacta puede ajustarse tras verificar APIs:

```text
list_output_devices() -> OutputDevice[]
get_selected_output_device() -> OutputDevice | null
set_output_device(device_id) -> DeviceSelectionResult
play_effect(effect_id) -> playback_id
stop_playback(playback_id) -> void
stop_effect(effect_id) -> void
stop_all() -> void
set_master_volume(value) -> void
set_playback_volume(playback_id, value) -> void
get_active_playbacks() -> Playback[]
get_audio_engine_status() -> AudioEngineStatus
```

Eventos planeados:

```text
audio:playback-started
audio:playback-finished
audio:playback-stopped
audio:playback-error
audio:device-changed
audio:device-error
```

## 7. Modelo de persistencia inicial

Entidades orientativas: `sound_effects`, `sound_banks`, `bank_effects`, `categories`, `keyboard_shortcuts`, `app_settings`.

- `sound_effects`: metadatos de archivo, duración, ruta/identificador, valores por defecto.
- `sound_banks`: nombre, orden y configuración.
- `bank_effects`: asignación efecto-banco, posición, color y comportamiento del botón.
- `categories`: clasificación reutilizable.
- `keyboard_shortcuts`: asignaciones y ámbito.
- `app_settings`: dispositivo preferido, volumen maestro, política de reproducción.

No guardar bytes completos de audio en SQLite por defecto. Usar migraciones versionadas, transacciones y restricciones de integridad. No almacenar rutas absolutas sin una estrategia de portabilidad.

## 8. Estándares de desarrollo

### Idioma y nombres

- Identificadores de código, tipos, métodos, archivos, commits y nombres de tests: **inglés**.
- Texto de la interfaz, README funcional, documentación, explicaciones, mensajes de error para usuarios, JSDoc y comentarios explicativos: **español**.
- Comentar decisiones y contratos, no repetir lo obvio.

### React/TypeScript

- TypeScript estricto; evitar `any`, casts inseguros y estados duplicados.
- Componentes enfocados, hooks reutilizables, comunicación con Rust encapsulada en adaptadores tipados.
- Cada función nueva o modificada debe llevar **JSDoc en español**: propósito, `@param` por parámetro, `@returns` cuando corresponda y `@throws` si aplica. Mantener sincronizado con el comportamiento real.
- Separar formularios/estado UI de servicios Tauri; no invocar comandos directamente desde componentes de presentación cuando pueda centralizarse.
- Validar datos externos, incluso payloads recibidos desde eventos o almacenamiento.

### Rust

- Preferir tipos fuertes, `Result`, errores de dominio, ownership explícito y RAII.
- No usar `unwrap()`/`expect()` en caminos de ejecución de producción salvo invariantes documentadas; usar manejo explícito de errores.
- Evitar `unsafe`; cualquier uso requiere justificación documentada y pruebas.
- Documentar funciones públicas en español con `///`; explicar invariantes de concurrencia.
- No bloquear el audio con logging síncrono o I/O.

### Seguridad

- Aplicar permisos mínimos y capabilities explícitas de Tauri 2.
- Restringir acceso a sistema de archivos a rutas necesarias; tratar los paths de entrada como no confiables.
- No ejecutar comandos shell arbitrarios a partir de información de archivos de audio.
- No introducir dependencias o servicios en red sin autorización.

### Cambios y calidad

- Cambios pequeños y relacionados con la tarea.
- No reestructurar módulos no afectados sin pedirlo.
- No borrar datos de usuario ni modificar archivos externos sin autorización.
- Nunca afirmar que se ejecutaron pruebas o compilaciones si no se ejecutaron.
- Antes de cada cambio significativo, inspeccionar el repositorio existente y respetar convenciones ya establecidas.

## 9. Rendimiento y criterios verificables

**Objetivos de producto, no garantías:**

- Meta inicial: **16 instancias simultáneas**, configurable y validada.
- Meta de latencia para efectos precargados: **p95 < 50 ms** desde orden de disparo hasta respuesta audible, sujeto a driver, dispositivo y sistema.
- Meta para `STOP ALL`: **p95 < 50 ms** hasta silencio de salida, a validar con medición real (considerar buffers del dispositivo).
- Uso de CPU y memoria sin crecimiento sostenido al iniciar y detener cientos de efectos.
- Al fallar un archivo, las demás reproducciones deben continuar.
- Sin clipping digital durante mezclas dentro del rango de prueba definido.

Crear pruebas automatizadas del dominio y pruebas de integración con motor simulado cuando no haya hardware. Complementar con pruebas manuales/documentadas por plataforma para latencia, dispositivos USB, desconexión, sonido simultáneo y salida real.

## 10. Plan de desarrollo: fases y puertas de aprobación

**Trabajar solamente en la fase que el usuario haya autorizado.** No saltar a otra fase por iniciativa propia.

### Fase 1 — Base y arquitectura

- Inspeccionar repositorio y prerrequisitos, sin sobrescribir archivos de usuario.
- Preparar Tauri 2 + React + TypeScript + Vite + herramientas de calidad.
- Definir estructura modular y contratos iniciales.
- Documentar `docs/ARCHITECTURE.md`, `docs/AUDIO_ENGINE.md`, `docs/ROADMAP.md` y `docs/DECISIONS/ADR-001-single-output.md`, `ADR-002-concurrent-playback.md`.
- Crear pantalla básica de arranque; **no implementar aún reproducción real**.
- Ejecutar validaciones disponibles, reportar resultados y bloquear avance hasta aprobación.

### Fase 2 — Paleta UI

- Maquetar botonera, colores, bancos, estados y accesibilidad con datos simulados.
- Implementar pruebas visuales/lógicas básicas sin motor real.

### Fase 3 — Audio nativo

- Implementar selección única de salida, reproducción concurrente, volumen, parada individual y general; eventos tipados, manejo de errores y pruebas.

### Fase 4 — Biblioteca y datos

- SQLite, migraciones, importación de audio, asignaciones a botones y persistencia.

### Fase 5 — Funciones profesionales

- Atajos, loops, fade, búsqueda, reorganización, importación/exportación y mejoras de UX según prioridad aprobada.

### Fase 6 — Validación y distribución

- Calidad, benchmarks, pruebas con hardware, empaquetado e instaladores Linux/Windows/macOS; advertir limitaciones cuando no se pueda probar algún sistema.

### Criterios para cerrar cada fase

1. Resumen de lo implementado y lo pendiente.
2. Archivos creados/modificados.
3. Comandos ejecutados con resultados reales; errores y riesgos.
4. Pruebas automáticas y manuales realizadas o pendientes.
5. Documentación y ADR actualizados si cambiaron decisiones.
6. Solicitar explícitamente autorización antes de la siguiente fase.

## 11. Forma de trabajo de OpenCode

Al recibir una instrucción:

1. Leer este `AGENTS.md` y la documentación relevante.
2. Comprobar estado actual del repositorio y fase autorizada.
3. Proponer un plan breve y señalar dependencias/riesgos.
4. Implementar exclusivamente lo pedido.
5. Ejecutar comprobaciones posibles (`npm run ...`, `cargo fmt --check`, `cargo clippy`, `cargo test`, etc. según scripts y entorno reales).
6. Documentar resultados, fallos y siguientes pasos.
7. **Detenerse y pedir aprobación** antes de pasar a la siguiente fase.

Si no existe el proyecto, el primer encargo recomendado es:

> "Lee AGENTS.md. Ejecuta exclusivamente la Fase 1 de RadioFX Studio: propón el plan, inicializa el proyecto si está vacío, genera la documentación arquitectónica, configura calidad y pruebas mínimas, verifica los resultados y detente. No inicies la Fase 2 sin mi aprobación."

**Importante:** colocar `AGENTS.md` en la raíz no inicia automáticamente la construcción. El usuario debe abrir OpenCode en esa carpeta y enviar una instrucción de inicio.
