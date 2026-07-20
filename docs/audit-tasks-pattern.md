# Patrón: tareas de auditoría/extracción con datos vivos

`lm_studio_agent` sirve bien para investigación/exploración delegable. Rinde mal
para un patrón específico: **"resumen ejecutivo cross-entidad con datos en vivo de
varios MCPs"** — pedirle en una sola llamada que junte datos de varias fuentes y
escriba un diagnóstico. Esta guía documenta por qué falla, qué se arregló a nivel
bridge, y qué sigue siendo responsabilidad de quien llama.

## El failure mode observado

Con una tarea real de ese tipo (varios MCPs de negocio, ventana de fechas
específica, pedido de resumen ejecutivo), el modelo local:

1. Cambió la ventana temporal pedida por otra (una fecha que ni siquiera había
   llegado todavía).
2. Inventó números que no salían de ninguna tool, o no coincidían con la lectura
   real de esa misma tool.
3. No distinguió "sección vacía" de "sin actividad real" (una fuente tenía un
   resumen general vacío pero SÍ tenía datos en una sub-sección específica — el
   modelo reportó "sin actividad" igual).
4. No levantó una señal de error técnico real que estaba en los datos (un endpoint
   fallando) — lo pasó por alto en vez de marcarlo como riesgo.
5. Mezcló contenido de una entidad con el resumen de otra.
6. Dio recomendaciones de acción no pedidas, en un contrato que era de solo lectura.

**Causa:** el modelo trató la tarea como redacción ("escribí un resumen que suene
bien"), no como auditoría ("verificá cada dato contra su fuente antes de
afirmarlo"). Con modelos locales esto es más probable que con el modelo grande —
son buenos completando texto plausible, no necesariamente buenos verificando cada
afirmación contra evidencia.

## Qué se arregló a nivel bridge (ya disponible)

- **`tool_trace`** (siempre en la respuesta de `lm_studio_agent`): qué tool se
  llamó, con qué argumentos, y qué devolvió (truncado a ~2000 chars). Aunque el
  texto libre del modelo invente algo, podés diffear cada afirmación contra lo que
  realmente salió de las tools — no hace falta confiar en la síntesis.
- **`response_schema`** (parámetro opcional): fuerza que la respuesta final sea
  JSON válido contra un schema exacto — no es una instrucción en el prompt que el
  modelo puede ignorar, es grammar-constrained decoding de LM Studio. Se aplica en
  una llamada extra **sin `tools`**, después de que el modelo termine su
  exploración libre — combinar `response_format` con `tools` en el mismo turno
  hace que el modelo prefiera inventar un JSON plausible antes que llamar la tool
  pedida (lo verificamos empíricamente: mismo prompt, mismo modelo, con
  `response_format` activo el modelo dejó de llamar una tool que sin ese flag sí
  llamaba).

Con ambos, la respuesta trae `{ final_text, structured, tool_trace }` — la prosa,
un JSON con la forma exacta que pediste, y la evidencia cruda para auditar ambos.

## Qué sigue siendo responsabilidad de quien llama

Ningún cambio en el bridge elimina la necesidad de pedir bien la tarea — el bridge
es un pipe genérico a cualquier MCP, no tiene idea de qué significan tus datos.
Estas reglas son del lado del caller (documentadas acá porque valen para
cualquiera que use este patrón, no solo para el caso donde se detectó el problema):

1. **Extracción, no diagnóstico.** Pedile al intern datos estructurados
   (`response_schema` con campos tipo `source_tool`, `metric`, `raw_value`), no un
   resumen ejecutivo con juicio. El diagnóstico final lo hace el agente supervisor
   (o una capa determinística), no el intern.
2. **Una llamada por entidad, no una cross-entidad.** Si tenés N fuentes/clientes/
   sistemas, N llamadas de `lm_studio_agent` (una por entidad, con solo el MCP de
   esa entidad) rinden mejor que una llamada con todos los MCPs juntos — menos
   superficie para mezclar contenido entre fuentes, y podés paralelizar.
3. **Prohibí inferencia sobre huecos.** El schema debería tener campos explícitos
   para `tool_errors` y `empty_sources` — y la instrucción explícita de "si una
   tool falla, registrá el error exacto y no infieras; si una tool no devuelve
   datos, marcá 'sin datos' en vez de asumir 'sin actividad'".
4. **Validación de reglas de negocio, no en el bridge.** Cosas como "si hay gasto
   registrado, no permitir 'sin actividad'" o "el rango reportado debe coincidir
   con el pedido" son reglas de TU dominio — el bridge no las conoce. Validalas
   vos (código determinístico, o el agente supervisor) contra `structured` y
   `tool_trace`, no confíes en que el modelo las va a respetar solo porque se lo
   pediste en el prompt.

## Prompt + schema de referencia

```text
Extraé datos de <fuente> para el rango <desde> a <hasta>.
No redactes diagnóstico ni recomendaciones.
Regla: si un dato no viene literalmente de una tool, no lo incluyas.
Regla: si una tool falla, registrá el error exacto en tool_errors y no infieras.
Regla: si una sección no devuelve datos, listala en empty_sources — no asumas que
significa "sin actividad" si otra sub-sección de la misma fuente sí tiene datos.
```

```json
{
  "type": "object",
  "properties": {
    "source_id": { "type": "string" },
    "range_requested": { "type": "string" },
    "range_used": { "type": "string" },
    "metrics": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "source_tool": { "type": "string" },
          "metric": { "type": "string" },
          "raw_value": { "type": "string" }
        },
        "required": ["source_tool", "metric", "raw_value"]
      }
    },
    "tool_errors": { "type": "array", "items": { "type": "string" } },
    "empty_sources": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["source_id", "range_requested", "range_used", "metrics", "tool_errors", "empty_sources"],
  "additionalProperties": false
}
```

Pasá ese JSON Schema como `response_schema` en la llamada a `lm_studio_agent`, y
validá `range_requested === range_used`, cruza cada `metrics[].raw_value` contra
`tool_trace`, y tratá cualquier entrada en `tool_errors` como bloqueante para el
diagnóstico final (no lo hagas vos con datos parciales silenciosos).

## Corolario: no delegues lectura de archivos fuera del árbol de trabajo

Un caso relacionado (score 1/10): se delegó a `lm_studio_agent`+filesystem "leé el
log de uso y armá un reporte". Falló porque el archivo vivía fuera de las rutas
autorizadas del filesystem MCP — y ampliar esas rutas para incluirlo habría expuesto
una carpeta con secretos/credenciales al modelo local.

Dos lecciones:

1. **"Resumí/reportá el contenido de este archivo" es una tarea de `lm_studio_generate`,
   no de `lm_studio_agent`.** El orquestador (que ya tiene acceso al archivo) lo lee y
   pasa el contenido en el prompt. Sin tool loop, sin problemas de rutas, más rápido.
   Reservá `lm_studio_agent`+filesystem para cuando el intern *tiene que descubrir*
   qué archivos leer, no cuando vos ya sabés cuál es.
2. **No amplíes los roots del filesystem MCP para alcanzar un archivo suelto en una
   carpeta sensible** (`~/.claude`, `~/.ssh`, dotfiles con tokens, etc.). El costo de
   seguridad supera la comodidad. Si el intern realmente necesita un archivo que vive
   ahí, copiá solo ese archivo a una ruta ya autorizada antes de delegar.
