# Aceptación desktop y hardware

## Estado y seguridad

**Protocolo pendiente, no resultados físicos ejecutados.** Linux tiene calidad/benchmark offline y arranque/reapertura del proceso release verificados según [PHASE_6.md](PHASE_6.md). El DEB solo fue generado e inspeccionado. Windows/macOS, selección/apertura física, audio audible, USB, E2E WebView y aceptación integral siguen pendientes. Ni tests simulados ni JSON offline certifican hardware.

Realizar las pruebas con autorización del responsable, fuera de emisión y con equipo de prueba. Empezar con volumen físico y maestro bajos, sin auriculares puestos ni señales a antena; incrementar solo tras verificar niveles. No lanzar 16 voces a volumen máximo. No desconectar una interfaz en uso por otros procesos. El benchmark offline no abre CPAL; el arranque GUI puede enumerar y sondear dispositivos, sin seleccionar automáticamente un stream.

Respaldar el perfil completo con todas las instancias cerradas. Usar archivos propios de prueba y perfiles aislados, nunca datos únicos de producción. Registrar evidencia antes/después sin borrar originales, huérfanos ni perfiles para hacer pasar un caso. Para migraciones, trabajar sobre una copia poblada v1 y conservar otra copia intacta. No usar una versión antigua sobre la única base v2.

## Ficha de ejecución

Completar una ficha por plataforma/dispositivo/driver/configuración; no extrapolar Linux a Windows/macOS ni una interfaz USB a todas.

| Campo                                                        | Valor a completar |
| ------------------------------------------------------------ | ----------------- |
| Responsable y autorización                                   | Pendiente         |
| Fecha/hora y zona                                            | Pendiente         |
| Versión, hash de paquete/binario y firma verificada          | Pendiente         |
| SO/versión, arquitectura, CPU/RAM y energía/carga de fondo   | Pendiente         |
| Backend/driver, dispositivo exacto y conexión USB/integrada  | Pendiente         |
| Frecuencia, canales, buffer efectivo y ganancias             | Pendiente         |
| Perfil aislado, copia de seguridad y archivos/hash de prueba | Pendiente         |
| Captura/loopback, calibración y criterio temporal            | Pendiente         |
| Casos, registros y resultado observado                       | Pendiente         |
| Incidencias y aceptación/rechazo del responsable             | Pendiente         |

## Matriz de aceptación

Todos los casos siguientes están pendientes salvo el arranque básico Linux ya registrado. Marcar por plataforma `aprobado`, `fallido`, `bloqueado` o `no aplicable` con justificación, evidencia y responsable. No convertir un timeout/SIGTERM en cierre normal aprobado.

| Área                 | Procedimiento y criterio                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paquete              | Instalar en VM/equipo limpio, comprobar menú/icono, arranque sin red y dependencias; en Windows verificar WebView2 offline incluido, en macOS firma/Gatekeeper/notarización cuando proceda.                                   |
| Ciclo de instalación | Actualizar sobre copia poblada con instancias cerradas, comprobar preservación; desinstalar y reinstalar sin pérdida no autorizada de datos. Registrar qué conserva el instalador.                                            |
| Inicio/cierre        | Ventana y UI cargadas, backend disponible, sin selección automática ni autoplay; cerrar normalmente y reabrir. Verificar recursos liberados, no solo muerte del proceso.                                                      |
| Biblioteca real      | Desde WebView importar WAV PCM/MP3/OGG Vorbis/FLAC, asignar botones, cerrar/reabrir y comprobar SQLite/audio/opciones/atajos durables. Selector cancelado sin cambios.                                                        |
| Fallos locales       | Archivo inválido/ausente/alterado y duplicados visibles, reparación sin tocar original; conflicto entre instancias recarga sin sobrescritura. No ejecutar fallos destructivos sobre datos reales.                             |
| Salida única         | Enumerar y confirmar una salida autorizada; todos los efectos por esa salida, sin otra ruta de producción ni stream por botón. Reiniciar: sugerencia de nombre no abre salida; ausencia/ambigüedad exige elección.            |
| Concurrencia         | Disparar varias instancias del mismo efecto con IDs distintos, luego 16; la 17 se rechaza sin robar voces. Fin natural recupera cupo; fallo de un recurso no corta otros.                                                     |
| Paradas/ganancias    | Parar instancia, efecto y todo; maestro cero silencia la mezcla, ganancia de instancia aislada y default solo para futuras voces. STOP no ejecuta fade ni revive voces anteriores tras rearmar.                               |
| Emergencia           | Ctrl+Shift+Space con aplicación enfocada, también desde campos/modales/selectores donde sea operativo; comprobar silencio y errores visibles. No es hotkey global del SO. Registrar limitaciones de foco del diálogo nativo.  |
| Loops/fades          | Escuchar vueltas/canales/transitorios a nivel bajo; desactivar loop termina vuelta, fade explícito irreversible retiene cupo hasta terminar. No aceptar como gapless ni transparente sin medición.                            |
| USB/cambio           | Cambiar salida detiene voces; apertura fallida restaura la anterior si es posible, sin reanudar. Desconectar la salida activa produce error visible, sin redirección silenciosa; reconectar exige decisión explícita.         |
| Bancos/paquetes      | Búsqueda, mover/copiar, atajos/conflictos, vista previa/cancelación, opt-in de atajos y exportación a destino nuevo; destino existente rechazado y paquete inválido sin cambios parciales.                                    |
| Accesibilidad        | Teclado, foco/restauración, lector de pantalla, contraste, zoom y estados/error/STOP comprensibles; comprobar escritorio y ventanas estrechas sin controles inaccesibles.                                                     |
| Calidad/niveles      | Capturar 1/16 voces con ganancias documentadas; muestras finitas, picos y ausencia de clipping en cadena real dentro del rango definido, escucha de coloración/clics. El tanh es saturación suave, no limitador transparente. |
| Estabilidad          | Cientos de disparos/paradas y sesión prolongada con consumo CPU/RSS/handles muestreado, carga/temperatura y duración registradas; ninguna voz/handle se acumula ni hay crecimiento sostenido inexplicado.                     |

La prueba Rust ignorada `explicitly_selected_real_output_opens_without_playing` requiere `RADIOFX_TEST_OUTPUT_NAME` exacto e inequívoco autorizado y solo abre/cierra una salida, sin señales. No se ejecutó y no sustituye esta matriz. No activar indiscriminadamente todos los tests ignorados: el benchmark exige release y filtro propio.

## Latencia física

Las metas son **p95 < 50 ms** para orden de disparo hasta respuesta audible y para STOP hasta silencio de salida. Siguen sin medir. El p95 del ACK o del render offline no puede sustituirlas; los buffers ya enviados al sistema/hardware no se retiran con STOP.

1. Definir y registrar el instante de orden y el umbral de aparición/silencio. Instrumentar una referencia temporal común con loopback/captura externa o adquisición equivalente; documentar calibración, resolución y demora del sistema de medida.
2. Precargar efectos de prueba y documentar selección de salida, sample rate, canales, buffer efectivo, ganancias, carga y número de voces. Separar arranque/conversión en frío de los disparos calientes; no mezclarlos en una sola cifra.
3. Recoger al menos 100 observaciones válidas de disparo y 100 de STOP por condición, conservando datos crudos y fallos. Probar 1 y 16 voces a nivel físico seguro; 64 solo con autorización y como escenario adicional, no requisito inicial.
4. Calcular p50/p95/p99 por rango más cercano, declarar tamaño de muestra y exclusiones justificadas. Informar por separado ACK software, salida capturada y latencia end-to-end; no restar retardos sin calibración acreditada.
5. Repetir con dispositivo integrado y USB autorizados, carga representativa y las plataformas objetivo. Adjuntar capturas/datos, nivel de ruido, umbrales y criterio de aceptación; un resultado favorable no certifica otro hardware.

La aceptación exige resultados medidos y decisión del responsable. Registrar cualquier incumplimiento sin redefinir retroactivamente el umbral. Las dos observaciones RSS del benchmark no son una prueba prolongada; medir tendencia, distinguir cachés/allocator de recursos vivos y conservar la serie temporal.

## Decisión final

Reunir fichas, incidencias y límites por plataforma. El responsable confirma o rechaza la aceptación y resuelve los bloqueos legales/de firma de [RELEASE.md](RELEASE.md). Fase 6 no se cierra por disponer de este protocolo ni se autoriza publicación automática; no se plantea una Fase 7.
