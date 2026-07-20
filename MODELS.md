# Modelos recomendados

Guía de arranque para elegir modelo local según el tipo de tarea. Llevá tu propio
registro de resultados con [`templates/intern-usage-log.template.md`](templates/intern-usage-log.template.md)
— los modelos y el hardware cambian, así que esta tabla es un punto de partida, no
una verdad fija.

## Setup probado (referencia)

MacBook Apple Silicon, LM Studio con runtime MLX. Todos los modelos de abajo están
descargados como cuantización 4-bit/5-bit MLX salvo que se indique lo contrario.

## Tabla de selección por tipo de tarea

| Tipo de tarea | Modelo | Por qué |
|---|---|---|
| Mecánica/un paso (CSV, renombrados, resúmenes, borradores) | `qwen3.6-35b-a3b` (default) | MoE rápido (~80 tok/s), alcanza para esto — no hace falta más |
| Código mecánico (patrones repetitivos, renombrados masivos, **archivos nuevos aislados con spec exacta**) | `qwen3-coder-30b` (pasar `model` explícito) | Especializado en código aunque sea de generación más vieja — un modelo especializado puede superar a uno general más nuevo en tareas de sintaxis/estructura |
| Complejidad moderada, tiempo no urgente (exploración con juicio real, edición multi-archivo no trivial) | `qwen3.6-27b` (dense) o `gemma-4-31b` (pasar `model` explícito) | Más inteligencia por token que el MoE rápido, a costa de velocidad — el cómputo local es gratis, así que la lentitud extra solo cuesta tiempo |
| Alta precisión/impacto real (bugs, vulnerabilidades, arquitectura, lógica con consecuencias reales) | Ninguno — hacerlo con el modelo "grande" (Claude/GPT) directo | El riesgo es de confiabilidad, no de tiempo; ningún modelo local da garantía suficiente todavía |

**Regla general:** si el tiempo no apremia, probá un modelo más capaz antes de asumir
que ninguno puede cruzar una tarea — vale la pena, porque solo cuesta tiempo, no
dinero (a diferencia del modelo grande que sí cobra por token).

**Regla operativa: un solo modelo cargado a la vez, siempre elegido a propósito.**
`resolveModel()` usa lo que ya esté cargado en memoria antes que el default fijo —
si dejás dos modelos cargados de sesiones distintas, el bridge puede terminar usando
el equivocado sin avisar. **Antes de una tanda con un modelo específico, llamá
`lm_studio_load_model({ model, exclusive: true })`** — descarga todos los demás y
deja solo ese cargado, así no hay ambigüedad. Es la forma robusta de cumplir esta
regla (reemplaza el `lms unload`/`load` manual).

## Modelos probados

Todos estos pasaron por este setup en algún momento (no solo los recomendados de
arriba). Verificación empírica, no benchmarks de papers:

| Modelo | Tamaño/tipo | Veredicto |
|---|---|---|
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

## Desactivar el "thinking" (recomendado)

Los modelos Qwen3 razonan por defecto antes de responder, lo cual es lento y no
aporta nada para tareas mecánicas. LM Studio **ignora los flags de la API** para esto
(`enable_thinking`, `chat_template_kwargs` — limitación conocida de LM Studio, no de
este bridge). La única forma confiable es editar el Prompt Template del modelo en la
app — ver [`docs/lm-studio-setup.md`](docs/lm-studio-setup.md#desactivar-el-thinking).
