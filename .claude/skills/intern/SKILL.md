---
name: intern
description: Delega trabajo a un modelo LLM local en LM Studio (vía MCP lm-studio) en vez de gastar cuota del modelo grande, en dos tiers - "subagent" para trabajo autónomo con tools (leer archivos, explorar, usar MCPs) e "intern" para transformación mecánica de texto. Delegar es el DEFAULT, no la excepción - usar proactivamente, sin esperar a que el usuario diga "usa el intern", en borradores largos, transformaciones repetitivas, resúmenes, boilerplate y exploración acotada de archivos. Saltearlo solo en alta precisión/impacto real (bugs, vulnerabilidades, arquitectura) o cuando explicarle el contexto cuesta más que hacerlo.
---

# Intern (LM Studio local)

Delegar la tarea al modelo local de LM Studio vía el servidor MCP `lm-studio`, en vez
de hacerla directo. LM Studio corre 100% local y no consume cuota del modelo grande
("ilimitado y gratis"), pero rinde peor en razonamiento complejo — este skill existe
para decidir bien CUÁNDO delegar y CON QUÉ modelo, no solo cómo llamar la tool.

**"El intern" no es sinónimo de subagentes** (el tool `Agent`/`Explore`/
`general-purpose`, etc.): esos corren en el modelo grande y consumen su cuota igual
que hacerlo directo. El intern es el MCP `lm-studio` — un modelo distinto, gratis,
local.

## 1. Dos tiers, y las tools de cada uno

`lm_studio_list_models` muestra el `tier=` de cada modelo:

- **`subagent` (junior)** — contexto largo y tool-calling confiable. Se le delega con
  **autonomía**: que lea los archivos él mismo, en vez de masticarle el contexto.
- **`intern`** — el resto. Delegación mecánica, todo el contexto en el prompt.

El roster se configura con `LM_STUDIO_SUBAGENT_MODELS="id-a,id-b"`. Es curado a
propósito: el host reporta `tool_use` para **todos** los modelos no-embedding, hasta
los de 1-2B, así que esa capability no sirve para decidir a quién confiarle un loop.

Tools:

- **`lm_studio_generate`** — solo texto/código, POST directo al modelo, **sin
  tools**. Tier intern. Dale todo el contexto necesario en el prompt (datos, texto
  fuente, resultados de tus propias tool calls) — no puede ir a buscar nada él mismo.
- **`lm_studio_agent`** — **con tools MCP reales**. Tier subagent. Le pasás
  `mcp_servers` (nombres de `~/.lmstudio/mcp.json`, listalos con
  `lm_studio_list_mcp_servers` antes) y corre un loop de agente real: llama tools, lee
  resultados, repite hasta terminar (tope `max_iterations`, default 8). Usá el mínimo
  de MCPs necesario — cada uno agrega tools al contexto del modelo. **Verificá cada
  dato contra el `tool_trace` que devuelve, no contra su prosa.**
- **`lm_studio_capacity`** — techo de memoria, modelos residentes y margen libre.
  Llamala antes de cargar un segundo modelo.
- **`lm_studio_list_models`** — qué modelos hay, cuál está cargado y en qué tier.
- **`lm_studio_list_mcp_servers`** — qué MCPs puede usar `lm_studio_agent`.

## 2. Cuándo delegar — delegar es el default

Trabajo mecánico/masivo y de bajo razonamiento: borradores largos, transformaciones
repetitivas, resúmenes, reescritura de texto, boilerplate. Y también **exploración
acotada con `lm_studio_agent`**: "leé estos archivos y resumime", "buscá X y
clasificá" — con el tier subagent eso se delega, no se hace directo por costumbre.

Hacerlo directo, sin delegar, solo si: (a) es alta precisión/impacto real — bugs,
vulnerabilidades, arquitectura, decisiones con consecuencia; (b) es ambiguo o urgente
y no hay margen para iterar; o (c) depende de contexto de la conversación que sería
más caro de explicarle que de hacer. Si hacés directo algo que entraba acá, decí en
una línea por qué.

**Calibrá el umbral con tus propios datos.** Al sacar el promedio del log, filtrá
**solo las filas cuya herramienta empiece con `lm_studio_`**: mezclar filas de otras
herramientas da un número que no dice nada sobre el intern.

## 3. Selección de modelo

Ver `MODELS.md` en la raíz de este repo para la tabla completa y evidencia real de
qué modelo sirvió para qué tipo de tarea. Regla general: si el tiempo no apremia,
probar un modelo más capaz antes de asumir que ninguno puede — el cómputo local es
gratis, así que la lentitud extra solo cuesta tiempo.

**Varios modelos a la vez: permitido, con chequeo.** `resolveModel()` desambigua por
tier — `lm_studio_generate` toma uno intern y `lm_studio_agent` uno subagent — así que
un subagente grande y un intern chico conviven sin pisarse. Si hay **dos del mismo
tier** cargados, ya no adivina: tira error y hay que pasar `model` explícito.

Antes de sumar un modelo, `lm_studio_capacity`. `lm_studio_load_model` con
`exclusive:false` verifica que entre y aborta con números si no; el auto-fit del host
no hace esa cuenta (dimensiona cada modelo como si fuera el único), y el
sobre-compromiso se manifiesta como swap, no como error. El host además **recorta el
`context_length` pedido en silencio** — verificá el valor real en `lms ps`.

**Auto-unload:** el bridge manda un `ttl` (default 600s) en cada request, así que todo
modelo que él levante se descarga solo al quedar ocioso — el contador se reinicia con
cada llamada, o sea una tanda seguida no paga recargas. La regla es **cargar otro
modelo solo cuando hace falta**. No cubre modelos ya residentes sin TTL (cargados a
mano o por LM Link): el TTL se fija al cargar, no retroactivamente, y
`lm_studio_capacity` los marca `SIN TTL`.

## 4. Umbral de descarte

Si verificar/corregir el output del intern después cuesta más del 70% de lo que
hubiera costado hacer la tarea directo, descartar el intern para ese tipo de tarea —
después de probar otro modelo (sección 3).

## 5. Registrar el uso (obligatorio)

Apenas el intern termina, puntualo vos mismo (1-10, comparado con haberlo hecho
directo) y agregá una fila a `~/.claude/intern-usage-log.md` (formato en
`templates/intern-usage-log.template.md` de este repo). Es el dato que permite
aprender con el tiempo qué modelo sirve para qué tipo de tarea.
