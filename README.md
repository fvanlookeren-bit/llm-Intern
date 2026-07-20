# llm-Intern

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io/)
![Works with](https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenClaw-8a2be2)

Servidor MCP que expone un modelo local de [LM Studio](https://lmstudio.ai/) como
tools de **Claude Code**, **Codex** y **OpenClaw** — "el intern": delegación de
trabajo mecánico o masivo a un modelo que corre gratis en tu propia máquina, para no
gastar cuota del modelo grande en tareas que no la necesitan.

En Claude Code / Codex el intern es la **excepción** (el modelo grande es el doer por
defecto). En OpenClaw el agente `main` lo usa **al revés**: es supervisor y **exprime
al intern como doer por defecto**, interviniendo solo para corregir o terminar. Ver
[`docs/openclaw-setup.md`](docs/openclaw-setup.md).

No es un reemplazo del modelo grande. Es un ayudante barato para lo mecánico, con
reglas claras de cuándo conviene usarlo y cuándo no.

```mermaid
flowchart LR
    subgraph Modelo grande
        CC[Claude Code]
        CX[Codex]
        OC[OpenClaw / otro agente]
    end
    CC -- MCP --> B(("mcp-lm-studio<br/>bridge"))
    CX -- MCP --> B
    OC -- MCP o provider directo --> B
    B -- HTTP local --> LM[LM Studio<br/>localhost:1234]
    LM --> Q1[qwen3.6-35b-a3b]
    LM --> Q2[qwen3-coder-30b]
    LM --> Q3[otros modelos locales]
```

## Por qué

El modelo grande (Claude, GPT) cobra por token y razona mejor. El modelo local
(LM Studio) es gratis e ilimitado, pero rinde peor en razonamiento complejo. Este
repo no es solo el bridge técnico — es también el **protocolo de decisión** (cuándo
delegar, con qué modelo, cómo medir si valió la pena) para que la delegación tenga
criterio y no sea "mandarle cualquier cosa al modelo chico". Ver [`MODELS.md`](MODELS.md).

## Qué incluye

- **`src/index.ts`** — el servidor MCP (Node/TypeScript). Cinco tools:
  - `lm_studio_generate` — texto/código sin herramientas, todo el contexto va en el prompt. Soporta `response_schema` (JSON Schema) para forzar salida estructurada.
  - `lm_studio_agent` — el modelo local con acceso real a tus otros MCPs (`~/.lmstudio/mcp.json`), loop de agente completo. Devuelve `tool_trace` (qué tool se llamó, con qué args, qué devolvió) para auditar cada dato de la respuesta, y soporta `response_schema` para forzar el formato final. Ver [`docs/audit-tasks-pattern.md`](docs/audit-tasks-pattern.md) para el patrón de uso en tareas de extracción/auditoría.
  - `lm_studio_load_model` — carga un modelo concreto con descarga exclusiva de los demás (vía el CLI `lms`). Llamalo antes de una tanda con un modelo específico para garantizar que ese, y solo ese, esté en memoria — mata de raíz el "modelo equivocado cargado".
  - `lm_studio_list_models` — qué hay descargado/cargado en LM Studio.
  - `lm_studio_list_mcp_servers` — qué MCPs puede usar `lm_studio_agent`.
- **`.claude/skills/intern/`** — Skill de Claude Code (`/intern`) con el protocolo completo.
- **`templates/`** — snippets para pegar en tu `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` y el `AGENTS.md` del `main` de OpenClaw (delegación automática, sin invocar el skill a mano), más `mcp.json` de ejemplo, el bloque MCP de OpenClaw y una plantilla de log de uso.
- **`MODELS.md`** — qué modelos usar para qué tipo de tarea, con los modelos que ya pasaron por este setup.
- **`docs/`** — guías de instalación por herramienta (Claude Code, Codex, OpenClaw, LM Studio) + [patrón de auditoría/extracción](docs/audit-tasks-pattern.md) + [roadmap](docs/roadmap.md) de mejoras en diseño.

## Integraciones

| Herramienta | Cómo se conecta | Guía |
|---|---|---|
| **Claude Code** | `claude mcp add` + Skill opcional | [`docs/claude-code-setup.md`](docs/claude-code-setup.md) |
| **Codex** | `[mcp_servers.lm-studio]` en `~/.codex/config.toml` | [`docs/codex-setup.md`](docs/codex-setup.md) |
| **OpenClaw** | MCP tool en `openclaw.json` + protocolo intern-first (agente `main` como supervisor) | [`docs/openclaw-setup.md`](docs/openclaw-setup.md) |

## Quickstart

Prerrequisito: [LM Studio](https://lmstudio.ai/) instalado, con al menos un modelo
descargado y el servidor local activo (`http://localhost:1234`). Ver
[`docs/lm-studio-setup.md`](docs/lm-studio-setup.md).

```bash
git clone https://github.com/fvanlookeren-bit/llm-Intern.git
cd llm-Intern
./install.sh
```

El instalador compila el bridge y, si tenés el CLI `claude`, te ofrece registrarlo.
Para el resto del setup por herramienta:

- [`docs/claude-code-setup.md`](docs/claude-code-setup.md)
- [`docs/codex-setup.md`](docs/codex-setup.md)
- [`docs/openclaw-setup.md`](docs/openclaw-setup.md) — protocolo intern-first para el agente `main`

Verificar que todo funciona:

```bash
node smoke-test.mjs
```

## Cómo se usa

Una vez instalado, en cualquier sesión de Claude Code, Codex u OpenClaw:

> "Usá el intern para resumir estos 40 archivos de log."

El modelo grande delega la tarea al MCP `lm-studio`, que corre local contra LM
Studio. Con las instrucciones de `templates/CLAUDE.snippet.md` /
`templates/AGENTS.snippet.md` / `templates/openclaw.snippet.md` instaladas, la
delegación también pasa **proactivamente** para tareas mecánicas obvias, sin que lo
pidas cada vez.

## Modelos probados y recomendados

Resumen — tabla completa y veredictos en [`MODELS.md`](MODELS.md):

| Modelo | Uso recomendado |
|---|---|
| `qwen/qwen3.6-35b-a3b` | ✅ Default — mecánico/un paso, rápido |
| `qwen/qwen3-coder-30b` | ✅ Código, solo tareas acotadas (no edición multi-archivo grande) |
| `qwen/qwen3.6-27b` / `gemma-4-31b` | ✅ Complejidad moderada, dense, más lento |
| `google/gemma-4-26b-a4b-qat` | ⚠️ Razonador — necesita `max_tokens` generoso o thinking off |
| `qwen/qwen3-4b-2507` | ⚠️ Solo tareas triviales |
| `liquid/lfm2.5-1.2b` | ❌ Alucina en preguntas factuales — solo transformación de texto pura |

## OpenClaw — el intern para ahorrar tokens del `main`

En [OpenClaw](https://openclaw.ai) el agente `main` suele correr en un modelo de
pago (GPT/Claude). Ese modelo es caro por token y no hace falta gastarlo en trabajo
mecánico. La integración del intern invierte el rol: **`main` es supervisor y el
intern es el doer por defecto.**

**El ahorro concreto:** en un ciclo intern-first, el modelo de pago no *produce* el
grueso — solo **planifica, revisa y corrige**. El volumen (borradores, variantes,
transformaciones, resúmenes, boilerplate) lo genera el modelo local, gratis. El
modelo de pago gasta unos cientos de tokens de supervisión en lugar de los miles que
costaría generar todo él mismo, y esos tokens locales tienen costo cero.

```
Sin intern:   main (pago) ─────────── genera 20 variantes ──────────►  ~miles de tokens de pago
Con intern:   main (pago) ─ planifica ─► intern (local, gratis) genera ─► main revisa/corrige
                              (cientos de tokens de pago)      (0 tokens de pago)   (cientos)
```

**Cómo se integra** (detalle en [`docs/openclaw-setup.md`](docs/openclaw-setup.md)):

1. Compilás el bridge (`npm run build`) y registrás el server `lm-studio` en
   `~/.openclaw/openclaw.json` → `mcp.servers` (bloque listo en
   [`templates/openclaw-mcp.snippet.json`](templates/openclaw-mcp.snippet.json)).
   OpenClaw expone las tools MCP por **tool-search**, así que el `main` descubre el
   intern por nombre cuando lo necesita.
2. Instalás el protocolo intern-first de
   [`templates/openclaw.snippet.md`](templates/openclaw.snippet.md) en el `AGENTS.md`
   del `main`. **Ojo:** no basta con pegarlo al final — hay que darle prioridad
   estructural cerca del inicio del archivo, o el modelo se ancla en sus directivas
   de arranque y sigue haciéndolo todo él mismo (ver la nota del paso 4 de la guía).

**Ejemplo real (verificado):** al pedirle al `main` "generá 20 subject lines para una
promo", con el protocolo bien instalado el `main` llama a `lm_studio_generate` (el
modelo local devuelve las variantes en ~8 s), después filtra y entrega las finales,
y registra el uso en el log — todo sin gastar tokens de pago en la generación.

## Configuración

Variables de entorno opcionales (todas tienen default):

| Variable | Default | Qué hace |
|---|---|---|
| `LM_STUDIO_BASE_URL` | `http://localhost:1234/v1` | Endpoint OpenAI-compatible de LM Studio |
| `LM_STUDIO_DEFAULT_MODEL` | `qwen/qwen3.6-35b-a3b` | Modelo que se JIT-carga si no hay ninguno ya cargado |
| `INTERN_MCP_CONFIG` | `~/.lmstudio/mcp.json` | Toolbox de `lm_studio_agent`. Apuntalo a un archivo curado para dar al intern un subconjunto acotado de MCPs (útil cuando lanza el bridge otro host, p.ej. OpenClaw) |

## Limitaciones conocidas (de LM Studio, no de este bridge)

- **Desactivar el "thinking" vía API no es confiable** — hay que editar el Prompt
  Template del modelo en la app. Ver [`docs/lm-studio-setup.md`](docs/lm-studio-setup.md#desactivar-el-thinking).
- `lm_studio_agent` razona peor que el modelo grande sobre cuándo/cómo usar cada
  tool — verificá el resultado, no lo asumas correcto.

## Licencia

MIT — ver [`LICENSE`](LICENSE).
