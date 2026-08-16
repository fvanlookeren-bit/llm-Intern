<!--
  Pegá esto en tu ~/.claude/CLAUDE.md (instrucciones globales, se cargan en toda
  sesión de Claude Code sin importar el proyecto). Reemplazá <TU_NOMBRE> y
  <RUTA_DEL_REPO> por tus valores reales. Ver docs/claude-code-setup.md para el
  resto de la instalación.
-->

## Delegar al "intern" (LM Studio local) — protocolo completo

**Delegar es el default — no esperes a que lo pidan.** La regla no es "evaluar si
conviene": es **delegar salvo que haya una razón concreta para no hacerlo** (ver
punto 2), sin necesidad de que <TU_NOMBRE> diga "usa el intern" cada vez. Si hacés
directo una tarea que entraba en el punto 2, decí en una línea por qué (ej. "esto es
de alta precisión, lo hago yo").

Si <TU_NOMBRE> dice "usa el intern" explícitamente, es obligatorio invocar **todo
este protocolo entero**, no solo "mandale un prompt" — y **no es sinónimo de
subagentes** (el tool `Agent`, `Explore`, `general-purpose`, etc.): esos corren en
el modelo grande y consumen su cuota/tokens igual que hacerlo directo; el intern
corre 100% local y gratis en LM Studio, en un modelo distinto. Si usás subagentes en
lugar del intern (o viceversa) cuando te lo pidieron explícito, es un error —
esperá que te corrijan.

**1. Dos tiers, no uno** (servidor MCP `lm-studio`, bridge en `<RUTA_DEL_REPO>`).
`lm_studio_list_models` muestra el `tier=` de cada modelo:

- **`subagent` (junior)** — el modelo con más capacidad y contexto que tengas
  cargado. Se le da una tarea con **autonomía**: que lea los archivos él mismo con
  `lm_studio_agent`, en vez de masticarle todo el contexto en el prompt.
- **`intern`** — el resto. Delegación mecánica con `lm_studio_generate`: todo el
  contexto va en el prompt, no explora por su cuenta.

El roster de tier subagent se configura con la variable de entorno
`LM_STUDIO_SUBAGENT_MODELS="id-a,id-b"`. Es una lista curada a propósito: la API del
host reporta `tool_use` para **todos** los modelos no-embedding, incluso los de 1-2B,
así que la capability no sirve para decidir a quién confiarle un loop autónomo — eso
sale de tu propia evidencia medida.

Tools:
- `lm_studio_generate` — texto/código, **sin tools**. Tier intern.
- `lm_studio_agent` — **con tools MCP reales**: le pasás `mcp_servers` (nombres de
  `~/.lmstudio/mcp.json`) y corre un loop de agente de verdad — llama tools, lee
  resultados, repite. Tier subagent. Usá el mínimo de MCPs necesario por llamada.
  **Su criterio sobre CUÁNDO y CÓMO usar cada tool sigue siendo más débil que el
  tuyo.** Verificá cada dato contra el `tool_trace` que devuelve la respuesta, no
  contra su prosa: puede redactar una síntesis plausible con cifras que no vinieron
  de ninguna tool. Que delegar sea el default no relaja esto — lo hace más
  importante.
- `lm_studio_capacity` — techo de memoria, modelos residentes y margen libre.
  Llamarla **antes** de cargar un segundo modelo.
- `lm_studio_list_models` / `lm_studio_list_mcp_servers` / `lm_studio_load_model`.

**2. Cuándo delegar — delegar es el default, no la excepción.** Todo lo
mecánico/masivo y de bajo razonamiento (borradores largos, transformaciones
repetitivas, resúmenes, boilerplate) y también **exploración acotada con
`lm_studio_agent`**: "leé estos archivos y resumime", "buscá X y clasificá".

Hacerlo directo, sin delegar, solo si: (a) es alta precisión/impacto real — bugs,
vulnerabilidades, arquitectura, decisiones con consecuencia; (b) es ambiguo o urgente
y no hay margen para iterar; o (c) depende de contexto de la conversación que sería
más caro de explicarle que de hacer.

**Calibrá este umbral con tus propios datos, no de memoria.** Cuando el log tenga
volumen, sacá el promedio filtrando **solo las filas cuya herramienta empiece con
`lm_studio_`** — si mezclás filas de otras herramientas el promedio no dice nada
sobre el intern.

**3. Selección de modelo** — ver [MODELS.md](../MODELS.md) del repo para la tabla
completa y la evidencia real detrás de cada recomendación. Regla general: si el
tiempo no apremia, probá un modelo más capaz antes de asumir que ninguno puede,
porque el cómputo local es gratis y solo cuesta tiempo.

**4. Varios modelos a la vez: permitido, con chequeo.** El bridge desambigua por
tier — `lm_studio_generate` prefiere un modelo intern y `lm_studio_agent` uno
subagent — así que un subagente grande y un intern chico conviven y cada tool toma el
suyo. Si hay **dos del mismo tier** cargados, `resolveModel()` no adivina: tira error
y hay que pasar `model` explícito.

Antes de sumar un modelo, `lm_studio_capacity`; `lm_studio_load_model` con
`exclusive:false` verifica que entre y aborta con números si no. El auto-fit del host
dimensiona cada modelo **como si fuera el único**, así que sin ese chequeo el
sobre-compromiso no da error al cargar — da swap después. Y ojo: el host puede
**recortar en silencio** el `context_length` que pidas; verificá el valor real en la
salida de `lms ps`, no asumas que se aplicó.

**Auto-unload:** el bridge manda un `ttl` en cada request
(`LM_STUDIO_TTL_SECONDS`, default 600s), así que todo modelo que él levante se
descarga solo al quedar ocioso. Es de inactividad — cada llamada reinicia el contador,
o sea una tanda seguida no paga recargas. La regla es **cargar otro modelo solo cuando
hace falta**, no dejar varios residentes por comodidad. No cubre modelos ya residentes
sin TTL (cargados a mano o desde otro equipo): el TTL se fija al cargar, no
retroactivamente; `lm_studio_capacity` los marca `SIN TTL`.

**5. Umbral de descarte:** si verificar/corregir su output después cuesta más del
70% de lo que hubiera costado hacer la tarea directo (`v > 0.70`), descartar el
intern para ese tipo de tarea — después de probar otro modelo (punto 3).

**6. Puntuar y registrar cada uso — obligatorio, no opcional.** Apenas el intern
termina una tarea, la puntuás vos mismo (1-10, qué tan bien la hizo comparado con
haberla hecho directo) y agregás una fila al log compartido Claude Code + Codex:
`~/.claude/intern-usage-log.md` — ver
[`templates/intern-usage-log.template.md`](intern-usage-log.template.md) para el
formato — herramienta, **modelo usado**, qué hizo (una frase), **score 1-10**, nota
breve. Es el dato que permite aprender con el tiempo qué modelo sirve para qué tipo
de tarea — sin esto no se puede comparar nada.
