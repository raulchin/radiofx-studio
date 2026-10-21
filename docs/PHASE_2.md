# Fase 2: paleta visual mock

## Estado y alcance

Fase 1 está aceptada por el usuario, manteniendo su historial de verificación nativa bloqueada. Fase 2 fue autorizada y su implementación es exclusivamente visual. La comprobación completa `npm run check` está superada. No se inicia Fase 3 sin autorización explícita.

La interfaz oscura mantiene acentos ámbar y marca provisional local, sin fuentes remotas ni servicios externos. El aviso MODO MOCK recuerda que no hay audio y que los cambios se pierden al recargar. La salida mostrada es simulada, no un dispositivo detectado.

## Uso

### Bancos

1. Selecciona En antena, Humor o Ambientes desde las pestañas o el selector superior. Ambientes permite probar un banco vacío.
2. Crea un banco con un nombre de hasta 80 caracteres. El nuevo banco queda activo.
3. Abre Organizar bancos para renombrar, mover antes/después o eliminar con confirmación.
4. No se puede eliminar el último banco: su acción de eliminación está deshabilitada y el store también rechaza la operación con un error en español. Al borrar el banco activo se selecciona el primero restante. No se elimina ningún archivo de audio.

### Botones y metadatos

1. Usa Agregar botón o la acción de edición de una tarjeta.
2. Introduce un nombre no vacío de hasta 100 caracteres y una categoría no vacía de hasta 60. Se recortan espacios exteriores.
3. Introduce la duración mock en segundos, no negativa y con precisión de milisegundos. Se almacena como milisegundos enteros y solo se presenta como duración; no se mide ni se decodifica un archivo.
4. Elige una de seis paletas: ámbar, coral, menta, cielo, violeta o pizarra. El estado también tiene texto, no depende solo del color.
5. Elige un estado visual de demostración y guarda. Eliminar un botón requiere confirmación y no afecta archivos.

Cada botón tiene un `id` de asignación independiente de `effectId: string | null`. Solo las semillas tienen IDs de efecto mock; los botones creados tienen `effectId: null`. Editar conserva ambas identidades. No existe importación ni asociación real de sonidos, aunque el formulario use la etiqueta Nombre del efecto.

### Estados y controles

Al pulsar una tarjeta se recorre `available → playing → paused → available`. Los textos representan disponible, reproduciendo y pausado **solo en la demo**. El estado `error` se selecciona en el editor y un clic no lo elimina: permanece hasta cambiarlo en el editor o usar `STOP ALL`.

El contador de actividad cuenta botones demo en `playing` entre todos los bancos, no voces ni instancias de reproducción. Las reproducciones reales son 0 y el motor está sin inicializar. No hay `playback_id`, fin automático por duración, límite de voces simulado ni reproducción del navegador.

El volumen maestro admite enteros 0–100 y solo cambia la presentación. `STOP ALL` restablece los estados demo de todos los bancos, incluidos pausados y errores, sin enviar comandos a Rust. No borra bancos ni botones y no cambia el volumen.

### Orden y accesibilidad

- Arrastra desde el asa de una tarjeta hacia otra del mismo banco usando DnD nativo; no hay traslado entre bancos.
- Usa los controles antes/después como alternativa mediante teclado o toque. No dependen de que el navegador admita arrastre táctil.
- Los diálogos usan `dialog` nativo, confinan el foco, cierran con Escape y devuelven el foco al control de origen; si deja de existir, usan el encabezado de la paleta como alternativa.
- Configuración permite columnas automáticas, 3, 4 o 6. La distribución se reduce según el ancho para evitar forzar una cuadrícula desktop en pantallas pequeñas.
- Se incluyen enlace para saltar a la paleta, etiquetas de controles y avisos de estado/error. No se acredita todavía una auditoría completa con lector de pantalla ni atajos globales configurables.

### Diagnóstico nativo

Configuración conserva Comprobar backend nativo. La consulta usa el adaptador y el contrato existentes, sin iniciar audio. En navegador no hay puente Tauri y se muestra el error correspondiente; no se finge una conexión. La aplicación desktop y el intercambio IPC real siguen sin verificar en esta entrega.

## Diseño y dependencias

`src/app/App.tsx` compone las vistas. `soundboard/store.ts` usa Zustand 5.0.15; `useSoundboard` coordina formularios y errores; `Soundboard` presenta tarjetas y ordenación; `presentation.ts` centraliza presentación de duración y etiquetas. `BankTabs` y `BankManager` gestionan navegación y CRUD/orden. `ButtonEditor`, `AudioControls`, `SettingsPanel` y el `Modal` compartido separan las demás responsabilidades.

Los modelos Zod validan recursos y entradas. `BankRepository` tiene `load` y `save` síncronos sobre una instantánea versión 1 en memoria: valida y copia, exige bancos e IDs coherentes y evita compartir referencias con su almacenamiento. El store guarda antes de publicar; los fallos de guardado no publican cambios parciales. Los estados demo, volumen y columnas no pertenecen a esa instantánea.

Esto no es persistencia durable ni un esquema SQLite. Fase 4 deberá adaptar el contrato al IPC Tauri asíncrono, incluyendo carga, errores, concurrencia y transacciones; no basta con sustituir el repositorio por una supuesta ABI SQLite compatible.

Para pruebas se añadieron Testing Library React 16.3.3, DOM 10.4.2, user-event 14.6.8 y jsdom 26.1.0. No se añadieron dependencias de UI o DnD. Playwright se utilizó de forma temporal fuera del manifiesto, no como infraestructura permanente del proyecto. El adaptador y contratos nativos, Rust y capabilities permanecen sin cambios.

## Verificación

Resultados de Fase 2 con Node 22.23.3 temporal: la cadena completa `npm run check` está superada, incluidos tipos, lint, formato, 50 pruebas en 4 archivos y build. El detalle, incluidos intentos fallidos corregidos, está en [VERIFICATION.md](VERIFICATION.md).

Prueba web real con Chrome del sistema mediante Playwright temporal y Vite en `127.0.0.1:1425`; el servicio existente en 1420 estaba ocupado y no se modificó.

| Tamaño    | Resultado de la revisión                                                  |
| --------- | ------------------------------------------------------------------------- |
| 1440×1000 | Carga desktop y captura revisada, sin desbordamiento horizontal.          |
| 390×844   | Carga móvil y captura revisada, sin desbordamiento horizontal.            |
| 320×720   | Carga en ancho pequeño y captura revisada, sin desbordamiento horizontal. |

En los tres tamaños se comprobó creación de botón/color, estados demo, `STOP ALL`, 20 pasos de Tab y 20 de Mayús+Tab contenidos en el modal, cierre con Escape y retorno de foco, sin errores JavaScript. También se comprobó arrastre nativo en desktop. No es una prueba en un teléfono físico ni una auditoría completa de accesibilidad.

Capturas temporales revisadas: `/tmp/opencode/radiofx-phase2-desktop.png`, `/tmp/opencode/radiofx-phase2-mobile.png` y `/tmp/opencode/radiofx-phase2-small.png`. Script temporal: `/tmp/opencode/radiofx-phase2-browser.cjs`. No son artefactos versionados ni dependencias permanentes. Las capturas iniciales accidentales del puerto 1420 en blanco se descartaron; la evidencia válida procede del puerto 1425.

## Límites y puerta

Sin audio, dispositivos reales, importación, persistencia tras recarga, SQLite, eventos del motor ni mediciones de latencia o mezcla. No se probaron Tauri nativo, Windows ni macOS. Los bloqueos de Rust/Cargo/`rsvg2` pertenecen al historial de Fase 1 y no se han vuelto a comprobar; su aceptación no se reabre.

Fase 2 entregada y validada en su alcance frontend mock. Se requiere autorización explícita del usuario antes de iniciar **Fase 3: audio nativo**.
