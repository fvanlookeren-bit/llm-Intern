# Modelos recomendados

Guía de arranque para elegir modelo local según el tipo de tarea. Llevá tu propio
registro de resultados con [`templates/intern-usage-log.template.md`](templates/intern-usage-log.template.md)
— los modelos y el hardware cambian, así que esta tabla es un punto de partida, no
una verdad fija.

## Setup probado (referencia)

MacBook Apple Silicon, LM Studio con runtime MLX. Todos los modelos de abajo están
descargados como cuantización 4-bit/5-bit MLX salvo que se indique lo contrario.

## Dos tiers: `subagent` y `intern`

El bridge clasifica cada modelo en un tier, visible en `lm_studio_list_models`:

- **`subagent` (junior)** — contexto largo y tool-calling confiable. Se le delega con
  **autonomía**: que lea los archivos él mismo vía `lm_studio_agent`, en vez de
  masticarle todo el contexto en el prompt.
- **`intern`** — el resto. Delegación mecánica de texto/código vía
  `lm_studio_generate`, con todo el contexto en el prompt.

El roster se define con `LM_STUDIO_SUBAGENT_MODELS="id-a,id-b"` (default en el
código: `qwen3.8-27b-mlx`). **Es una lista curada a propósito, no auto-detectada.**
Verificado el 2026-08-16: `/api/v0/models` reporta `capabilities: ["tool_use"]` para
**todos** los modelos no-embedding del catálogo, incluido `liquid/lfm2.5-1.2b` — o
sea la capability describe si la arquitectura soporta tool-calling, no si el modelo
es lo bastante bueno para que se le confíe un loop autónomo. Ese juicio sale de tu
registro de uso, no de la spec sheet.

## Tabla de selección por tipo de tarea

| Tipo de tarea | Modelo | Tier | Por qué |
|---|---|---|---|
| Con tools / leer archivos / exploración autónoma | `qwen3.8-27b-mlx` | subagent | Único medido con tool-calling confiable: eligió la tool correcta a la primera en todas las pruebas y los datos rastrean al `tool_trace`. Contexto real 147K (ver abajo) |
| Mecánica/un paso (CSV, renombrados, resúmenes, borradores) | `qwen3.6-35b-a3b` (default) | intern | MoE rápido (~80 tok/s), alcanza para esto — no hace falta más |
| Código mecánico (patrones repetitivos, renombrados masivos, **archivos nuevos aislados con spec exacta**) | `qwen3-coder-30b` (pasar `model` explícito) | intern | Especializado en código aunque sea de generación más vieja — un modelo especializado puede superar a uno general más nuevo en tareas de sintaxis/estructura |
| Complejidad moderada, tiempo no urgente (exploración con juicio real, edición multi-archivo no trivial) | `qwen3.6-27b` (dense) o `gemma-4-31b` (pasar `model` explícito) | intern | Más inteligencia por token que el MoE rápido, a costa de velocidad — el cómputo local es gratis, así que la lentitud extra solo cuesta tiempo |
| Alta precisión/impacto real (bugs, vulnerabilidades, arquitectura, lógica con consecuencias reales) | Ninguno — hacerlo con el modelo "grande" (Claude/GPT) directo | — | El riesgo es de confiabilidad, no de tiempo; ningún modelo local da garantía suficiente todavía |

**Debilidad transversal, vale para todos los tiers:** las cifras **agregadas** (sumas,
promedios, conteos sobre muchos ítems) fallan seguido, aunque el razonamiento
cualitativo alrededor sea sólido. Nunca aceptes un número agregado sin verificarlo con
código o contra el `tool_trace`.

**Segundo modo de falla, en reescrituras:** cuando le pedís "aplicá estos cambios a
este documento", lo que **no** esté en la spec explícita puede desaparecer aunque
estuviera en el original. Pedí siempre "conservá todo lo que no mencioné" y revisá con
`git diff`, no leyendo su resumen.

**Regla general:** si el tiempo no apremia, probá un modelo más capaz antes de asumir
que ninguno puede cruzar una tarea — vale la pena, porque solo cuesta tiempo, no
dinero (a diferencia del modelo grande que sí cobra por token).

## Varios modelos a la vez

Se puede tener un subagent y un intern residentes al mismo tiempo, cada uno atendiendo
lo suyo. `resolveModel()` desambigua **por tier**: `lm_studio_generate` prefiere un
modelo intern y `lm_studio_agent` uno subagent. Si hay **dos del mismo tier** cargados
ya no adivina — tira error y hay que pasar `model` explícito. (Antes elegía "el primero
cargado" en silencio, que era la causa del viejo consejo de dejar uno solo.)

Para una tanda con un modelo específico y cero ambigüedad, sigue sirviendo
`lm_studio_load_model({ model, exclusive: true })`.

**Antes de sumar un segundo modelo, `lm_studio_capacity`.** Reporta el techo de
memoria, los pesos residentes y el margen libre; `lm_studio_load_model` con
`exclusive:false` hace el mismo chequeo y aborta con números si no entra.

### Por qué el chequeo es necesario (medido, M4 Pro 48 GB, 2026-08-16)

El auto-fit del host dimensiona cada modelo **como si fuera el único**. Con dos
residentes le asignó a uno el safe ceiling entero ignorando los ~15 GiB que el otro ya
ocupaba: el sobre-compromiso no da error al cargar, da swap después. Del log:

```
context_fit: family=qwen3_5 max=262,144 fitted=147,456
  working_set=42.00GiB reserve=3.00GiB safe_ceiling=39.00GiB baseline=14.95GiB
  full_kv=65536B/token prompt_inputs=10240B/token attention=98304B/token
```

Tres cosas que valen para cualquier máquina:

1. **`working_set` sigue exactamente a `iogpu.wired_limit_mb`** (37.44 GiB con el
   default de macOS; 42.00 GiB tras `sudo sysctl iogpu.wired_limit_mb=43008`). El techo
   lo pone el wired limit, no la RAM libre ni cuántos modelos haya cargados. El sysctl
   **se pierde en cada reboot** — si dependés de él, ponelo en un LaunchDaemon.
2. **El costo por token es ~2,7× el KV cache solo.** Acá 64 KiB/token de KV + 10 de
   prompt inputs + 96 de buffer pico de atención = 170 KiB/token. Dimensionar con el KV
   solo subestima feo.
3. **El host recorta el `context_length` pedido en silencio, sin error.** Verificá
   siempre el valor real en `lms ps`; no asumas que se aplicó.

El guardrail de la app (`modelLoadingGuardrails`) **no** mueve el `reserve=3.00GiB` del
auto-fit — son mecanismos distintos. Ponerlo en `off` no compra contexto.

## Modelos probados

Todos estos pasaron por este setup en algún momento (no solo los recomendados de
arriba). Verificación empírica, no benchmarks de papers:

| Modelo | Tamaño/tipo | Veredicto |
|---|---|---|
| `qwen3.8-27b-mlx` | Híbrido 27B (48 capas linear-attn + 16 full-attn) | ✅ **Tier subagent.** El único medido con tool-calling confiable: eligió la tool correcta a la primera en todas las pruebas, sin fabricar. Su arquitectura híbrida hace el KV cache ~4× más barato que un denso equivalente (64 KiB/token contra ~256), por eso sostiene 147K de contexto en 48 GB. Lento (~14 tok/s). Ojo: en reescrituras tiende a perder lo que no esté en la spec explícita |
| `qwen/qwen3.6-35b-a3b` | MoE ~35B (A3B activos) | ✅ Recomendado — default, rápido, alcanza para la mayoría de la delegación mecánica |
| `qwen/qwen3-coder-30b` | MoE 30B, code-tuned | ✅ Recomendado para código — pero **solo tareas acotadas** (archivo nuevo con spec clara). En edición multi-archivo grande se puede colgar sin converger. |
| `qwen/qwen3.6-27b` | Dense 27B | ✅ Recomendado para complejidad moderada — más lento que el MoE, más consistente en tareas que requieren más juicio |
| `qwen/qwen3-4b-2507` | Dense 4B | ⚠️ Usable para tareas triviales/hardware limitado — no esperar más que eso |
| `gemma-4-31b-it-mlx` / `gemma-4-31b-it-uncensored-mlx` | Dense 31B | ✅ Alternativa válida a `qwen3.6-27b` para complejidad moderada |
| `google/gemma-4-26b-a4b-qat` | MoE 26B (A4B activos), razonador | ⚠️ Con `max_tokens` chico puede devolver `content` vacío — gasta el presupuesto en `reasoning_content` antes de llegar a la respuesta. Subir `max_tokens` o desactivar el thinking (ver abajo). |
| `google/gemma-4-e2b` / `google/gemma-4-e4b` | Dense chico | ⚠️ Probados livianamente, sin veredicto firme — candidatos para tareas triviales |
| `liquid/lfm2.5-1.2b` | Dense 1.2B | ❌ Muy rápido pero alucina en preguntas que requieren conocimiento real (probado: inventó una definición incorrecta de "servidor MCP"). Solo para transformaciones de texto puramente mecánicas, sin contenido factual. |
| `text-embedding-nomic-embed-text-v1.5` | Embeddings | No aplica a `lm_studio_generate`/`lm_studio_agent` (no es un modelo de chat) |

## Cómo descargar estos modelos

Desde la app de LM Studio → pestaña Discover/buscar, o por CLI (`lms get`, si tenés
el LM Studio CLI instalado):

```bash
lms get qwen/qwen3.6-35b-a3b        # default — MoE rápido, alcanza para la mayoría
lms get qwen/qwen3-coder-30b        # código mecánico / archivos nuevos aislados
lms get qwen/qwen3.6-27b            # dense, más lento, más "inteligente por token"
lms get qwen/qwen3-4b-2507          # chico y rápido, para tareas triviales o hardware limitado
```

Elegí la cuantización según tu RAM disponible (4-bit para equipos con menos memoria
unificada, 8-bit/full si te sobra). En Apple Silicon, preferí siempre la variante MLX
sobre GGUF — corre notablemente más rápido en ese hardware.

## Vision vs text-only: importa para la memoria

Los modelos de **visión** (`type: vlm` en `/api/v0/models`) **no admiten cuantización
de KV cache** en LM Studio. Los **text-only** (`type: llm`) sí. Con contextos grandes
esa es la diferencia entre entrar en RAM o no: comprobado en los presets de una misma
instalación, un MoE text-only tenía `kvCacheQuantization.enabled: true` a 4 bits con
262144 de contexto, mientras el equivalente con visión lo tenía forzado en `false`.

Si te pelea la memoria con un modelo grande, revisá primero si es `vlm`. Ojo: casi
toda la generación reciente de Qwen (3.5/3.6, tanto 27B como 35B-A3B) es multimodal
por arquitectura (`ForConditionalGeneration` + `vision_config`), así que **no existe
una variante text-only de esos modelos** — hay que cambiar de familia, no de quant.
Para verificarlo antes de descargar 20 GB, mirá el `config.json` del repo en Hugging
Face: si tiene `vision_config`, es vlm.

## Desactivar el "thinking" (recomendado)

Los modelos Qwen3 razonan por defecto antes de responder, lo cual es lento y no
aporta nada para tareas mecánicas. LM Studio **ignora los flags de la API** para esto
(`enable_thinking`, `chat_template_kwargs` — limitación conocida de LM Studio, no de
este bridge). La única forma confiable es editar el Prompt Template del modelo en la
app — ver [`docs/lm-studio-setup.md`](docs/lm-studio-setup.md#desactivar-el-thinking).
