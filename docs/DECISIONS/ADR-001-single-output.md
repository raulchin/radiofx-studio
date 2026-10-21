# ADR-001: una sola salida de audio

## Estado

Decisión arquitectónica aceptada. Dispositivos y mezcla implementados en Fase 3 con Rodio 0.21.1 y CPAL 0.16; Fase 4 autorizada añade preferencia durable. Compilación Linux y pruebas sin hardware superadas. Aceptación de salida física y recorrido desktop pendientes; Fase 5 no autorizada.

## Contexto

La estabilidad en cabina requiere conocer exactamente por dónde suena la mezcla. Abrir una salida por efecto multiplica recursos y complica sincronización, ganancias y recuperación. Los nombres e identificadores de hardware no siempre son estables entre reinicios.

## Decisión

Todos los efectos se mezclan hacia un único dispositivo activo mediante un stream común por motor/instancia de aplicación. No se abre un stream por botón ni por reproducción. La salida se enumera y selecciona explícitamente. Dos procesos pueden compartir SQLite, pero cada uno tiene motor/stream propio; no se garantiza una salida global ni sincronización del audio entre procesos.

No se abre salida al arrancar ni se selecciona automáticamente el dispositivo predeterminado. Fase 4 guarda en SQLite únicamente el nombre de una salida realmente abierta o restaurada, nunca su UUID de sesión. La UI compara nombres: una coincidencia única se informa como sugerencia, pero también exige elegir y confirmar. Nombre ausente o ambiguo requiere decisión explícita, sin autoapertura ni salto silencioso al predeterminado. El nombre no acredita identidad física permanente.

Cada enumeración genera tokens UUID nuevos asociados a handles reales de CPAL; los tokens anteriores dejan de ser seleccionables y devuelven `invalid_device`. El handle de la salida activa se conserva aparte: renovar la lista no cambia ni cierra por sí solo el stream. Nombres duplicados no identifican inequívocamente hardware y no se marcan como predeterminado si hay varias coincidencias.

Para cambiar la salida se detienen las reproducciones, se intenta abrir la nueva y, si falla, se intenta recuperar la anterior. Se informa del resultado y de cualquier imposibilidad de restauración. La recuperación no reanuda implícitamente las voces detenidas.

Si la salida desaparece o falla durante el uso, se muestra un error y se conserva un estado seguro. No se redirige el audio a otro dispositivo sin decisión del usuario.

El callback solo marca atómicamente el fallo. El worker retira voces y cierra la salida; puede conservarse el metadato de selección como no disponible en `device_error`, nunca como salida lista. `DeviceSelectionResult` informa instantánea, `restored_previous` y error; recuperar la salida anterior también puede fallar y se comunica. No se abre más de un stream a la vez.

## Consecuencias

- Simplifica el control de mezcla, maestro y `STOP ALL`.
- El cambio de dispositivo interrumpe deliberadamente las reproducciones.
- Requiere resolución y recuperación explícitas; no basta con guardar un índice de enumeración.
- Excluye múltiples salidas y preescucha independiente del MVP.

## Validación y pendientes

Pruebas con driver simulado cubren arranque sin enumeración/apertura, renovación de tokens, rechazo de IDs caducados, cierre antes de abrir, fallo y restauración incluso tras renovar el registro, fallo de restauración, desconexión y ausencia de fallback. La prueba de handlers/ACL Tauri también rechaza tokens antiguos, con transporte/runtime simulados.

Fase 4 prueba reapertura de SQLite y restauración de preferencias sin abrir salida, nombres duplicados y mensajes UI de coincidencia/ausencia/ambigüedad. Persistir ajustes ocurre fuera del worker y puede fallar después de cambiar audio: el fallo parcial es visible, no se simula rollback.

Pendientes: arranque/reinicio GUI, enumeración/apertura física, nombres ambiguos reales, USB/desconexión y restauración en hardware, y confirmación de salida única audible sin redirecciones. La prueba ignorada de apertura exige nombre exacto autorizado, no reproduce señales y no se ejecutó. Véanse [PHASE_4.md](../PHASE_4.md), el registro histórico [PHASE_3.md](../PHASE_3.md) y [VERIFICATION.md](../VERIFICATION.md).
