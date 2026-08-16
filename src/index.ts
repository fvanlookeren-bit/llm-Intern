#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Ubica el CLI `lms` (necesario para lm_studio_load_model). Orden: LMS_PATH
// explícito → ~/.lmstudio/bin/lms → bundle de la app → el PATH.
// Sirve igual para LM Studio y para Bionic (Element Labs):
// Bionic es un derivado que comparte el mismo home `~/.lmstudio` e instala ahí
// el mismo binario `lms` (verificado: mismo SHA que el que trae en su bundle).
// El fallback al bundle cubre una instalación donde `~/.lmstudio/bin/lms` no
// quedó linkeado.
function resolveLmsBinary(): string {
  if (process.env.LMS_PATH) return process.env.LMS_PATH;
  const candidates = [
    path.join(os.homedir(), ".lmstudio", "bin", "lms"),
    "/Applications/Bionic.app/Contents/Resources/app/.webpack-bionic/lms",
    "/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "lms";
}

interface LoadedInstance {
  identifier: string;
  deviceIdentifier?: string;
  remote: boolean;
}

// Devuelve los modelos cargados y si cada uno vive en ESTA máquina o en otra
// vía LM Link. `/api/v0/models` no expone el device, así que la única fuente
// confiable es el CLI: `lms link status` lista los identifiers de los equipos
// REMOTOS, y `lms ps --json` trae el deviceIdentifier de cada instancia cargada.
// Si algo falla (no hay CLI, formato distinto), se devuelve lista vacía y quien
// llame debe tratarlo como "no sé" en vez de asumir que todo es local.
async function listLoadedInstances(lms: string): Promise<LoadedInstance[]> {
  const remoteDevices = new Set<string>();
  try {
    // Ojo: `lms link status` imprime en STDERR, no en stdout (verificado). Leer
    // solo stdout devolvía cero devices y hacía que un modelo remoto se
    // clasificara como local — justo el caso que este chequeo debe evitar.
    const { stdout, stderr } = await execFileAsync(lms, ["link", "status"], { timeout: 15000 });
    for (const m of `${stdout}\n${stderr}`.matchAll(/Identifier:\s*([0-9a-f]{8,})/gi)) {
      remoteDevices.add(m[1]);
    }
  } catch {
    // LM Link puede estar apagado o el comando no existir: sin devices remotos
    // conocidos, todo lo cargado se considera local.
  }

  try {
    const { stdout } = await execFileAsync(lms, ["ps", "--json"], { timeout: 15000 });
    const rows = JSON.parse(stdout) as Array<{ identifier?: string; deviceIdentifier?: string }>;
    return rows
      .filter((r) => r.identifier)
      .map((r) => ({
        identifier: r.identifier as string,
        deviceIdentifier: r.deviceIdentifier,
        remote: Boolean(r.deviceIdentifier && remoteDevices.has(r.deviceIdentifier)),
      }));
  } catch {
    return [];
  }
}

const BASE_URL = process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234/v1";
const ORIGIN = BASE_URL.replace(/\/v1\/?$/, "");
const NATIVE_MODELS_URL = `${ORIGIN}/api/v0/models`;

// Modelo por defecto cuando no hay nada cargado en LM Studio. Si le asignás un
// preset propio como default de carga en LM Studio (~/.lmstudio/.internal/
// user-concrete-model-default-config/<model-id>.json — ver docs/lm-studio-setup.md),
// fijarlo acá (en vez de "el primero del catálogo") asegura que el JIT-load
// dispare siempre ese preset, no un modelo al azar sin esa config.
const DEFAULT_MODEL = process.env.LM_STUDIO_DEFAULT_MODEL ?? "qwen/qwen3.6-35b-a3b";

// --- Tiers: "sub-agente junior" vs "intern" ---------------------------------
//
// Dos niveles de delegación, no uno:
//
//   - `subagent` (junior): modelo con contexto y capacidad suficientes para
//     correr un loop de agente REAL con tools (lm_studio_agent) — leer archivos,
//     consultar MCPs, decidir el próximo paso. Se le puede dar una tarea con
//     cierta autonomía en vez de todo el contexto masticado en el prompt.
//   - `intern`: delegación mecánica de texto/código (lm_studio_generate). Todo
//     el contexto va en el prompt; no explora por su cuenta.
//
// **Por qué el tier es una lista curada y no se deriva de la API.** `/api/v0/models`
// reporta `capabilities: ["tool_use"]` para TODOS los modelos no-embedding del
// catálogo, incluido `lfm2.5-1.2b` (1.2B params). O sea la capability describe si
// la arquitectura soporta tool-calling, no si el modelo es lo bastante bueno para
// que se le confíe un loop autónomo. Ese juicio sale de la evidencia medida en
// MODELS.md y `~/.claude/intern-usage-log.md`, no de una spec sheet — por eso vive
// acá, versionado y revisable, en vez de auto-detectarse.
//
// Override por entorno (lista separada por comas). Sirve para otra máquina con
// otro catálogo, sin tocar código: LM_STUDIO_SUBAGENT_MODELS="modelo-a,modelo-b".
// Un valor vacío ("") desactiva el tier de sub-agente: todo pasa a ser intern.
type ModelTier = "subagent" | "intern";

const DEFAULT_SUBAGENT_MODELS = ["qwen3.8-27b-mlx"];

function subagentRoster(): Set<string> {
  const raw = process.env.LM_STUDIO_SUBAGENT_MODELS;
  if (raw === undefined) return new Set(DEFAULT_SUBAGENT_MODELS);
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function tierOf(modelId: string): ModelTier {
  return subagentRoster().has(modelId) ? "subagent" : "intern";
}

// --- Auto-unload por TTL -----------------------------------------------------
//
// Un modelo residente ocupa su memoria aunque nadie lo use, y en esta máquina eso
// se acumula: basta que dos queden cargados para sobre-comprometer el techo (ver
// la nota de capacidad más abajo). Como el host recarga rápido (~11-20s para un 27B
// en MLX), conviene soltar la memoria cuando el trabajo termina en vez de retenerla
// "por si acaso".
//
// El mecanismo es el TTL del host: descarga el modelo tras N segundos sin usarlo.
// Verificado el 2026-08-16: `/v1/chat/completions` acepta un campo `ttl` en el body
// y lo aplica al modelo que JIT-carga esa misma request (se comprobó viendo el TTL
// en `lms ps` tras una llamada a un modelo que no estaba cargado). Por eso el bridge
// lo manda en cada request: cualquier modelo que levante por su cuenta queda con
// auto-unload, sin que nadie tenga que acordarse de descargarlo.
//
// Es un TTL de INACTIVIDAD, no un timer fijo: cada request lo reinicia, así que una
// tanda de llamadas seguidas no paga recargas — solo se libera cuando Claude
// realmente dejó de usar el intern.
//
// Límite conocido: el TTL se fija al CARGAR. Si el modelo ya estaba residente sin
// TTL (cargado a mano, desde la GUI, o por LM Link desde otro equipo), mandarlo en
// la request no se lo agrega retroactivamente — hay que recargarlo con
// lm_studio_load_model. Es justamente el caso de los modelos que aparecen solos.
//
// 0 desactiva el auto-unload (comportamiento viejo: el modelo queda hasta que algo
// lo descargue).
const DEFAULT_TTL_SECONDS = (() => {
  const raw = process.env.LM_STUDIO_TTL_SECONDS;
  if (raw === undefined) return 600;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 600;
})();

// Campo `ttl` para el body de una request de chat, o nada si está desactivado.
function ttlField(): Record<string, number> {
  return DEFAULT_TTL_SECONDS > 0 ? { ttl: DEFAULT_TTL_SECONDS } : {};
}

// --- Capacidad de memoria: ¿entra otro modelo? -------------------------------
//
// Varios modelos a la vez SÍ se puede (es `exclusive:false` en lm_studio_load_model),
// pero conviene mirar la memoria antes, porque el auto-fit de LM Studio no lo hace
// por vos. Medido el 2026-08-16 en un M4 Pro de 48 GB con dos modelos residentes:
//
//   context_fit: family=qwen3_5 fitted=147,456 working_set=42.00GiB
//     reserve=3.00GiB safe_ceiling=39.00GiB baseline=14.95GiB
//     full_kv=65536B/token prompt_inputs=10240B/token attention=98304B/token
//
// Dos hallazgos que valen para cualquier máquina:
//
//  1. `working_set` sigue EXACTAMENTE a `iogpu.wired_limit_mb` (37.44 GiB con el
//     default, 42.00 GiB tras `sysctl ...=43008`). O sea el techo lo pone el wired
//     limit, no la RAM libre ni cuántos modelos haya cargados.
//  2. El auto-fit dimensiona cada modelo **como si fuera el único**: le asignó a
//     qwen los 39 GiB enteros del safe ceiling ignorando los ~15 GiB que gemma ya
//     tenía residentes. Con dos modelos cargados eso sobre-compromete la memoria,
//     y el síntoma es swap cuando ambos trabajan a la vez, no un error al cargar.
//
// Por eso este chequeo suma los PESOS residentes (dato duro de `lms ps --json`) y
// los compara contra el techo. No intenta predecir el KV cache de cada arquitectura:
// varía demasiado (qwen3_5 gasta 64 KiB/token de KV porque 16 de sus 64 capas son
// full-attention; gemma4 usa ventana deslizante y su pico rotativo fue 0.59 GiB
// para 226K de contexto). Predecirlo bien exigiría leer el config de cada modelo,
// así que se reporta lo que se sabe con certeza y se avisa de lo que no.
const GIB = 1024 ** 3;
const CONTEXT_FIT_RESERVE_BYTES = 3 * GIB;

// Fracción de la RAM total que macOS deja usar a la GPU cuando `iogpu.wired_limit_mb`
// es 0 (default). Aproximación: en el M4 Pro de 48 GiB medido, LM Studio reportó
// working_set=37.44GiB, que es 0.78 del total. Es una estimación, no un valor
// documentado por Apple — cuando el wired limit está fijado explícitamente se usa
// ese número y esta constante no interviene.
const DEFAULT_WIRED_FRACTION = 0.78;

interface MemoryBudget {
  totalBytes: number;
  budgetBytes: number;
  explicitLimit: boolean;
  source: string;
}

async function memoryBudget(): Promise<MemoryBudget> {
  const totalBytes = os.totalmem();
  let explicitLimit = false;
  let budgetBytes = totalBytes * DEFAULT_WIRED_FRACTION;
  let source = `estimado (${DEFAULT_WIRED_FRACTION} × RAM total; iogpu.wired_limit_mb=0)`;
  try {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "iogpu.wired_limit_mb"], {
      timeout: 5000,
    });
    const mb = Number.parseInt(stdout.trim(), 10);
    if (Number.isFinite(mb) && mb > 0) {
      budgetBytes = mb * 1024 * 1024;
      explicitLimit = true;
      source = `iogpu.wired_limit_mb=${mb}`;
    }
  } catch {
    // No es macOS, o no existe el sysctl: se queda con la estimación por fracción.
  }
  return { totalBytes, budgetBytes, explicitLimit, source };
}

interface LoadedDetail {
  identifier: string;
  sizeBytes: number;
  contextLength?: number;
  maxContextLength?: number;
  parallel?: number;
  status?: string;
  ttlMs?: number | null;
  remote: boolean;
}

// Igual que listLoadedInstances pero conservando los campos que hacen falta para
// razonar sobre memoria. Se mantienen las dos porque listLoadedInstances es el
// camino caliente de lm_studio_load_model y solo necesita identifier + remote.
async function listLoadedDetails(lms: string): Promise<LoadedDetail[]> {
  const remoteDevices = new Set<string>();
  try {
    const { stdout, stderr } = await execFileAsync(lms, ["link", "status"], { timeout: 15000 });
    for (const m of `${stdout}\n${stderr}`.matchAll(/Identifier:\s*([0-9a-f]{8,})/gi)) {
      remoteDevices.add(m[1]);
    }
  } catch {
    // LM Link apagado: todo lo cargado se considera local.
  }
  try {
    const { stdout } = await execFileAsync(lms, ["ps", "--json"], { timeout: 15000 });
    const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return rows
      .filter((r) => typeof r.identifier === "string")
      .map((r) => ({
        identifier: r.identifier as string,
        sizeBytes: typeof r.sizeBytes === "number" ? r.sizeBytes : 0,
        contextLength: typeof r.contextLength === "number" ? r.contextLength : undefined,
        maxContextLength: typeof r.maxContextLength === "number" ? r.maxContextLength : undefined,
        parallel: typeof r.parallel === "number" ? r.parallel : undefined,
        status: typeof r.status === "string" ? r.status : undefined,
        ttlMs: typeof r.ttlMs === "number" ? r.ttlMs : null,
        remote: Boolean(
          typeof r.deviceIdentifier === "string" && remoteDevices.has(r.deviceIdentifier)
        ),
      }));
  } catch {
    return [];
  }
}

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(2)} GiB`;
}

// Tamaño en disco de CADA modelo del catálogo, cargado o no (`lms ls --json` trae
// sizeBytes para todos). Es lo que permite decidir si otro modelo entra ANTES de
// intentar cargarlo: /api/v0/models no expone el tamaño, y `lms ps --json` solo
// conoce los que ya están residentes.
async function catalogSizes(lms: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  try {
    const { stdout } = await execFileAsync(lms, ["ls", "--json"], { timeout: 20000 });
    const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const key = typeof r.modelKey === "string" ? r.modelKey : null;
      if (key && typeof r.sizeBytes === "number") sizes.set(key, r.sizeBytes);
    }
  } catch {
    // Sin CLI o formato distinto: quien llame debe tratar el Map vacío como
    // "no sé el tamaño", nunca como "pesa cero".
  }
  return sizes;
}

// --- Log de actividad: una línea JSON por invocación del intern. ---
//
// Por qué existe: algunos hosts no muestran las tools MCP por su nombre. OpenClaw,
// por ejemplo, con toolSearch activo invoca todo a través de un dispatcher genérico
// (`tool_call`), así que en su UI no se distingue "el intern trabajó" de cualquier
// otra tool. Este log es la fuente de verdad host-agnóstica: `tail -f` sobre él
// muestra en vivo qué delegaciones están pasando, sin importar quién llame.
//
// Nunca debe romper una tool: si el archivo no se puede escribir, se ignora.
// Desactivable con INTERN_ACTIVITY_LOG=off. Prompts truncados a propósito —
// es un registro de actividad, no un archivo de transcripciones.
const ACTIVITY_LOG_PATH =
  process.env.INTERN_ACTIVITY_LOG ?? path.join(os.homedir(), ".lmstudio", "intern-activity.jsonl");
const ACTIVITY_LOG_ENABLED = ACTIVITY_LOG_PATH.toLowerCase() !== "off";
const ACTIVITY_SNIPPET_MAX = 160;

function snippet(text: string | undefined, max = ACTIVITY_SNIPPET_MAX): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function logActivity(entry: Record<string, unknown>): void {
  if (!ACTIVITY_LOG_ENABLED) return;
  try {
    fs.appendFileSync(
      ACTIVITY_LOG_PATH,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
    );
  } catch {
    // Silencioso a propósito: la observabilidad nunca debe tumbar la delegación.
  }
}

interface NativeModel {
  id: string;
  type?: string; // "llm" | "vlm" | "embeddings"
  state?: string; // "loaded" | "not-loaded"
  max_context_length?: number;
  loaded_context_length?: number;
}

async function fetchJson(url: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(
      `No se pudo conectar a LM Studio en ${url}. ¿Está corriendo el servidor local? (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LM Studio respondió ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

async function lmFetch(path: string, init?: RequestInit) {
  return fetchJson(`${BASE_URL}${path}`, init);
}

async function listNativeModels(): Promise<NativeModel[]> {
  const data = (await fetchJson(NATIVE_MODELS_URL)) as { data?: NativeModel[] };
  return data.data ?? [];
}

// Prefiere un modelo ya cargado en memoria (state: "loaded") antes que dejar
// que el host haga JIT-load del primero del catálogo — así se usa lo que
// el usuario ya tiene corriendo en la app, no un modelo al azar.
//
// OJO con LM Link (corrección 2026-08): la suposición vieja era que
// /api/v0/models solo devolvía modelos locales a esta máquina. **Es falsa.**
// Con LM Link activo, un modelo cargado en OTRO equipo aparece acá con
// state:"loaded" (verificado con Bionic: el único "loaded" corría en otra Mac,
// confirmado con `lms ps --json` → deviceIdentifier y `lms link status`).
// El endpoint no expone el device, así que desde la API REST no se puede
// distinguir local de remoto — solo el CLI `lms` lo sabe.
//
// Consecuencias prácticas: (1) el intern puede terminar corriendo en otra
// máquina, lo cual funciona pero cambia dónde se gasta la RAM/CPU; (2) validar
// el 'model' explícito contra el catálogo sigue valiendo la pena para atajar
// typos, pero "está en el catálogo" ya no implica "está descargado acá".
//
// Desambiguación por tier (2026-08): antes esto hacía `.find(state === "loaded")`,
// o sea "el primero cargado". Con UN solo modelo residente daba igual, pero desde
// que se soporta tener varios a la vez esa heurística elige en silencio y puede
// mandar una tarea de agente al modelo chico, o una transformación mecánica al
// grande y lento. Ahora `preferTier` resuelve el caso normal (generate → intern,
// agent → subagent) y, si sigue habiendo ambigüedad DENTRO del tier, se lanza un
// error que obliga a pasar 'model' explícito en vez de adivinar.
async function resolveModel(model?: string, preferTier?: ModelTier): Promise<string> {
  const models = await listNativeModels();
  const localNonEmbedding = models.filter((m) => m.type !== "embeddings");

  if (model) {
    if (localNonEmbedding.some((m) => m.id === model)) return model;
    const available = localNonEmbedding.map((m) => m.id).join(", ") || "(ninguno)";
    throw new Error(
      `El modelo '${model}' no está en el catálogo que reporta el host (puede ser un ID inválido o un modelo ` +
        `no descargado). Modelos disponibles: ${available}`
    );
  }

  const loaded = localNonEmbedding.filter((m) => m.state === "loaded");

  const pickFrom = (candidates: NativeModel[], scope: string): string | null => {
    if (candidates.length === 1) return candidates[0].id;
    if (candidates.length > 1) {
      const listed = candidates.map((m) => `${m.id} (${tierOf(m.id)})`).join(", ");
      throw new Error(
        `Hay ${candidates.length} modelos cargados ${scope} y no se puede elegir sin adivinar: ${listed}. ` +
          `Pasá el parámetro 'model' explícito, o dejá cargado uno solo de ese tier ` +
          `(lm_studio_load_model con exclusive:true). Ver lm_studio_capacity para el estado actual.`
      );
    }
    return null;
  };

  if (preferTier) {
    const sameTier = loaded.filter((m) => tierOf(m.id) === preferTier);
    const picked = pickFrom(sameTier, `del tier '${preferTier}'`);
    if (picked) return picked;
    // Ninguno del tier pedido: se cae al conjunto general (mejor usar lo que hay
    // que fallar), pero manteniendo la regla anti-adivinanza.
  }

  const picked = pickFrom(loaded, "en memoria");
  if (picked) return picked;

  // Nada cargado: preferir el default fijo (dispara JIT-load consistente con
  // su preset "mcps" ya aplicado) antes que "el primero del catálogo" al azar.
  if (localNonEmbedding.some((m) => m.id === DEFAULT_MODEL)) return DEFAULT_MODEL;

  const anyModel = localNonEmbedding[0];
  if (anyModel) return anyModel.id;

  throw new Error(
    "No hay ningún modelo cargado ni disponible en LM Studio. Cargá uno en la app o pasá el parámetro 'model' explícitamente."
  );
}

// --- Puente de tools reales: el intern conecta como CLIENTE MCP a los ---
// --- servidores definidos en ~/.lmstudio/mcp.json (misma fuente de   ---
// --- verdad que usa la app de LM Studio), descubre sus tools, se las ---
// --- pasa al modelo, y ejecuta lo que pida — un loop de agente real. ---

interface LmStudioMcpServerConfig {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

// Toolbox del intern-agent (lm_studio_agent). Por defecto ~/.lmstudio/mcp.json —
// la misma fuente de verdad que usa la app de LM Studio. Se puede apuntar a otro
// archivo con INTERN_MCP_CONFIG para dar al intern un toolbox curado distinto del
// de la app (útil cuando el bridge lo lanza otro host — p.ej. OpenClaw — y querés
// que el intern tenga solo un subconjunto acotado de MCPs). El formato es el mismo:
// { "mcpServers": { "<nombre>": { url|command, ... } } }.
const LMSTUDIO_MCP_JSON =
  process.env.INTERN_MCP_CONFIG ?? path.join(os.homedir(), ".lmstudio", "mcp.json");

function loadLmStudioMcpConfig(): Record<string, LmStudioMcpServerConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(LMSTUDIO_MCP_JSON, "utf-8");
  } catch (err) {
    throw new Error(
      `No pude leer ${LMSTUDIO_MCP_JSON}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, LmStudioMcpServerConfig> };
  return parsed.mcpServers ?? {};
}

async function connectMcpServer(name: string, config: LmStudioMcpServerConfig): Promise<Client> {
  const client = new Client({ name: `mcp-lm-studio-agent-${name}`, version: "0.1.0" });
  if (config.url) {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
    await client.connect(transport);
  } else if (config.command) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
    });
    await client.connect(transport);
  } else {
    throw new Error(`El server "${name}" en mcp.json no tiene "url" ni "command".`);
  }
  return client;
}

// Nombre de tool visible al modelo: "<server>__<tool>" — evita colisiones
// entre servers que definan tools con el mismo nombre, y permite rutear
// cada tool_call de vuelta al cliente MCP correcto.
function prefixedToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const server = new McpServer({ name: "lm-studio", version: "0.1.0" });

server.registerTool(
  "lm_studio_list_models",
  {
    title: "Listar modelos de LM Studio",
    description:
      "Lista los modelos del servidor local de LM Studio (http://localhost:1234) e indica cuáles están " +
      "actualmente cargados en memoria (state: loaded) vs solo disponibles para JIT-load, y en qué TIER " +
      "está cada uno: 'subagent' (junior, apto para lm_studio_agent con tools y autonomía) o 'intern' " +
      "(delegación mecánica de texto vía lm_studio_generate). El tier es una lista curada, no una " +
      "capability de la API — ver la nota en el código sobre por qué.",
    inputSchema: {},
  },
  async () => {
    const models = await listNativeModels();
    if (!models.length) {
      return { content: [{ type: "text", text: "No hay modelos en LM Studio." }] };
    }
    const lines = models.map((m) => {
      const state = m.state === "loaded" ? "cargado" : "no cargado";
      const tier = m.type === "embeddings" ? "—" : tierOf(m.id);
      const ctx =
        m.state === "loaded" && m.loaded_context_length
          ? ` ctx=${m.loaded_context_length.toLocaleString("es")}/${(m.max_context_length ?? 0).toLocaleString("es")}`
          : m.max_context_length
            ? ` ctx_max=${m.max_context_length.toLocaleString("es")}`
            : "";
      return `${m.id} [${state}] tier=${tier}${m.type ? ` (${m.type})` : ""}${ctx}`;
    });
    return {
      content: [
        {
          type: "text",
          text:
            `${lines.join("\n")}\n\n` +
            `tier=subagent → usar con lm_studio_agent (tools, contexto largo, autonomía).\n` +
            `tier=intern   → usar con lm_studio_generate (todo el contexto en el prompt).\n` +
            `Override: LM_STUDIO_SUBAGENT_MODELS="id-a,id-b". Memoria: lm_studio_capacity.`,
        },
      ],
    };
  }
);

server.registerTool(
  "lm_studio_capacity",
  {
    title: "Memoria disponible: ¿entra otro modelo a la vez?",
    description:
      "Reporta el techo de memoria del host, qué modelos están residentes y cuánto margen queda, para " +
      "decidir si conviene cargar OTRO modelo en paralelo (varios sub-agentes a la vez) o si hay que " +
      "liberar antes. Llamar esto ANTES de un lm_studio_load_model con exclusive:false. " +
      "Importante: el auto-fit de LM Studio dimensiona cada modelo como si fuera el único que hay, así " +
      "que no te protege del sobre-compromiso — este chequeo existe justamente para eso. Solo mira PESOS " +
      "residentes (dato duro); el KV cache depende de la arquitectura y del contexto y no se predice acá.",
    inputSchema: {
      candidate_model: z
        .string()
        .optional()
        .describe(
          "ID de un modelo que estás pensando cargar además de los actuales. Si se pasa, se compara su " +
            "tamaño en disco contra el margen libre y se devuelve un veredicto."
        ),
    },
  },
  async ({ candidate_model }) => {
    const lms = resolveLmsBinary();
    const [budget, loaded] = await Promise.all([memoryBudget(), listLoadedDetails(lms)]);

    const local = loaded.filter((i) => !i.remote);
    const remote = loaded.filter((i) => i.remote);
    const residentBytes = local.reduce((sum, i) => sum + i.sizeBytes, 0);
    const ceiling = budget.budgetBytes - CONTEXT_FIT_RESERVE_BYTES;
    const headroom = ceiling - residentBytes;

    const lines: string[] = [];
    lines.push(`RAM total: ${gib(budget.totalBytes)}`);
    lines.push(`Techo de memoria del host: ${gib(budget.budgetBytes)}  [${budget.source}]`);
    lines.push(`Reserva del auto-fit: ${gib(CONTEXT_FIT_RESERVE_BYTES)} → safe ceiling ${gib(ceiling)}`);
    lines.push("");

    if (!local.length) {
      lines.push("Modelos residentes en esta máquina: ninguno.");
    } else {
      lines.push(`Modelos residentes en esta máquina (${local.length}):`);
      for (const i of local) {
        const ctx = i.contextLength ? `ctx=${i.contextLength.toLocaleString("es")}` : "ctx=?";
        const par = i.parallel ? ` parallel=${i.parallel}` : "";
        const st = i.status ? ` ${i.status}` : "";
        const ttl = i.ttlMs ? ` ttl=${Math.round(i.ttlMs / 60000)}m` : " SIN TTL";
        lines.push(
          `  - ${i.identifier}  ${gib(i.sizeBytes)}  ${ctx}${par}  tier=${tierOf(i.identifier)}${st}${ttl}`
        );
      }
      const noTtl = local.filter((i) => !i.ttlMs);
      if (noTtl.length && DEFAULT_TTL_SECONDS > 0) {
        lines.push(
          `  ⚠ ${noTtl.length} sin TTL (${noTtl.map((i) => i.identifier).join(", ")}): retienen su memoria ` +
            `hasta que algo los descargue. El TTL se fija al cargar, así que mandarlo en las requests no se ` +
            `lo agrega retroactivamente — recargalos con lm_studio_load_model para que se auto-descarguen.`
        );
      }
    }
    if (remote.length) {
      lines.push(
        `Instancias en otros equipos (LM Link, no cuentan para esta memoria): ${remote
          .map((i) => i.identifier)
          .join(", ")}`
      );
    }

    lines.push("");
    lines.push(`Pesos residentes: ${gib(residentBytes)}`);
    lines.push(`Margen libre (solo pesos): ${gib(headroom)}`);
    lines.push(
      "Ojo: el margen NO descuenta el KV cache, que crece con el contexto y depende de la arquitectura " +
        "(p.ej. qwen3_5 gasta ~64 KiB/token porque 16 de sus 64 capas son full-attention; gemma4 usa " +
        "ventana deslizante y gasta muchísimo menos). Dejá holgura real, no cargues hasta el borde."
    );

    if (candidate_model) {
      lines.push("");
      if (local.some((i) => i.identifier === candidate_model)) {
        lines.push(`'${candidate_model}' YA está residente en esta máquina.`);
      } else {
        const sizes = await catalogSizes(lms);
        const size = sizes.get(candidate_model);
        if (size === undefined) {
          lines.push(
            `No pude leer el tamaño de '${candidate_model}' (¿ID mal escrito, o el CLI 'lms' no responde?). ` +
              `Verificá el ID con lm_studio_list_models.`
          );
        } else {
          const fits = size < headroom;
          lines.push(
            `Candidato '${candidate_model}' (tier=${tierOf(candidate_model)}): pesa ${gib(size)} contra ` +
              `${gib(headroom)} de margen → ${fits ? "ENTRA" : "NO ENTRA"} solo por pesos.`
          );
          if (fits) {
            lines.push(
              `Quedarían ${gib(headroom - size)} para el KV cache de TODOS los modelos residentes. ` +
                `Si eso es menos de ~4 GiB, esperá contextos cortos o swap.`
            );
          }
        }
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "lm_studio_load_model",
  {
    title: "Cargar un modelo (con descarga exclusiva local)",
    description:
      "Carga un modelo específico vía el CLI `lms`, descargando primero los demás modelos cargados " +
      "**en esta máquina** (exclusive=true, default). Resuelve de raíz el problema recurrente de 'modelo " +
      "equivocado cargado': llamá esto ANTES de una tanda de trabajo con un modelo concreto (ej. un modelo " +
      "de código) para garantizar que ese, y solo ese, esté en memoria — así lm_studio_generate/" +
      "lm_studio_agent no toman por error un modelo que quedó cargado de otra sesión. " +
      "**Seguro con LM Link:** si hay instancias cargadas en OTROS equipos, no se tocan (un `unload --all` " +
      "las apagaría y podría tumbar el modelo del que depende un agente allá). " +
      "**Varios modelos a la vez:** con exclusive:false se suma este modelo a los ya residentes (p.ej. un " +
      "sub-agente grande + un intern chico, cada uno atendiendo lo suyo). Antes de cargar se verifica que " +
      "entre en memoria y se aborta con números si no — usá lm_studio_capacity para verlo de antemano. " +
      "Requiere el CLI `lms` (lo instalan tanto LM Studio como Bionic; se busca en LMS_PATH, " +
      "~/.lmstudio/bin/lms, el bundle de la app, o el PATH). Devuelve `lms ps` al terminar.",
    inputSchema: {
      model: z
        .string()
        .describe("ID del modelo a cargar (ver lm_studio_list_models para los IDs locales válidos)."),
      exclusive: z
        .boolean()
        .optional()
        .default(true)
        .describe("Si true (default), descarga los demás modelos cargados EN ESTA MÁQUINA antes de cargar este. Las instancias en otros equipos (LM Link) nunca se tocan."),
      include_remote: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Solo aplica con exclusive=true. Si true, la descarga previa ALCANZA TAMBIÉN a las instancias " +
            "cargadas en otros equipos vía LM Link. Peligroso: si en ese equipo corre un agente que depende " +
            "de su modelo, se lo apagás. Usalo solo si sabés que esas máquinas no están sirviendo a nadie."
        ),
      ttl: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Segundos de inactividad tras los cuales el host descarga el modelo (auto-unload). Omitir = usar " +
            "el default del bridge (LM_STUDIO_TTL_SECONDS, 600s). Pasar 0 para dejarlo residente sin TTL."
        ),
      context_length: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Longitud de contexto a usar al cargar. Omitir = default del modelo. OJO: LM Studio hace " +
            "auto-fit y RECORTA este valor en silencio si no entra en memoria (sin error) — verificá el " +
            "contexto real en la salida de `lms ps` que devuelve esta tool, no asumas que se aplicó."
        ),
      parallel: z
        .number()
        .int()
        .positive()
        .max(16)
        .optional()
        .describe(
          "Predicciones concurrentes que admite el modelo. Para un sub-agente que trabaja de a una tarea, " +
            "usá 1: cada slot extra reserva memoria y recorta el contexto disponible."
        ),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Solo aplica con exclusive:false. Salta el chequeo de memoria que impide cargar un modelo que no " +
            "entra junto a los residentes. Usar solo si sabés que el margen alcanza."
        ),
    },
  },
  async ({ model, exclusive, include_remote, ttl, context_length, parallel, force }) => {
    // Validar el ID contra el catálogo local antes de invocar lms (mismo criterio
    // que resolveModel para un 'model' explícito) — evita un lms load que falle o,
    // peor, matchee parcialmente otro modelo.
    const models = await listNativeModels();
    const localNonEmbedding = models.filter((m) => m.type !== "embeddings");
    if (!localNonEmbedding.some((m) => m.id === model)) {
      const available = localNonEmbedding.map((m) => m.id).join(", ") || "(ninguno)";
      return {
        content: [
          {
            type: "text",
            text: `El modelo '${model}' no está entre los modelos locales. Disponibles: ${available}`,
          },
        ],
        isError: true,
      };
    }

    const lms = resolveLmsBinary();
    const steps: string[] = [];
    try {
      // Multi-modelo (exclusive:false): antes de sumar otro residente, verificar
      // que entre. El auto-fit de LM Studio NO hace esta cuenta — dimensiona cada
      // modelo como si fuera el único, así que sin este gate el sobre-compromiso
      // no da error al cargar, da swap después, cuando dos modelos trabajan a la
      // vez y ya es difícil de atribuir.
      if (!exclusive && !force) {
        const [budget, loadedNow, sizes] = await Promise.all([
          memoryBudget(),
          listLoadedDetails(lms),
          catalogSizes(lms),
        ]);
        const localNow = loadedNow.filter((i) => !i.remote);
        const alreadyResident = localNow.some((i) => i.identifier === model);
        const residentBytes = localNow.reduce((sum, i) => sum + i.sizeBytes, 0);
        const headroom = budget.budgetBytes - CONTEXT_FIT_RESERVE_BYTES - residentBytes;
        const size = sizes.get(model);
        if (!alreadyResident && size !== undefined && size >= headroom) {
          return {
            content: [
              {
                type: "text",
                text:
                  `No cargo '${model}' junto a los residentes: pesa ${gib(size)} y solo quedan ` +
                  `${gib(headroom)} de margen.\n\n` +
                  `Techo: ${gib(budget.budgetBytes)} [${budget.source}] − ${gib(CONTEXT_FIT_RESERVE_BYTES)} ` +
                  `de reserva − ${gib(residentBytes)} de pesos residentes (${localNow
                    .map((i) => i.identifier)
                    .join(", ")}).\n\n` +
                  `Opciones: exclusive:true para descargar los otros primero; subir el techo con ` +
                  `\`sudo sysctl iogpu.wired_limit_mb=<MB>\`; o force:true si sabés lo que hacés. ` +
                  `Ver lm_studio_capacity para el detalle.`,
              },
            ],
            isError: true,
          };
        }
        if (size !== undefined && !alreadyResident) {
          steps.push(
            `Chequeo de memoria OK: ${gib(size)} contra ${gib(headroom)} de margen ` +
              `(quedarán ${gib(headroom - size)} para KV cache).`
          );
        }
      }
      if (exclusive) {
        // NO usar `unload --all`: con LM Link, `lms ps` incluye instancias
        // cargadas en OTRAS máquinas, y un unload masivo las apagaría — puede
        // tumbar el modelo del que depende un agente corriendo en ese otro
        // equipo. Se descargan solo las instancias locales, una por una.
        const loaded = await listLoadedInstances(lms);
        const toUnload = include_remote ? loaded : loaded.filter((i) => !i.remote);
        const spared = include_remote ? [] : loaded.filter((i) => i.remote);

        for (const inst of toUnload) {
          await execFileAsync(lms, ["unload", inst.identifier], { timeout: 60000 });
        }
        steps.push(
          toUnload.length
            ? `Descargado(s) ${toUnload.length} modelo(s): ${toUnload.map((i) => i.identifier).join(", ")}.`
            : "No había modelos que descargar."
        );
        if (spared.length) {
          steps.push(
            `Respetada(s) ${spared.length} instancia(s) en otros equipos (LM Link): ` +
              `${spared.map((i) => i.identifier).join(", ")} — no se tocaron (usá include_remote:true para incluirlas).`
          );
        }
      }
      const loadArgs = ["load", model, "-y"];
      // Sin `ttl` explícito se aplica el default del bridge, para que un modelo
      // cargado por acá también se auto-descargue al quedar ocioso. `ttl: 0`
      // explícito significa "quiero que quede residente" y desactiva el auto-unload.
      const effectiveTtl = ttl ?? (DEFAULT_TTL_SECONDS > 0 ? DEFAULT_TTL_SECONDS : undefined);
      if (effectiveTtl !== undefined && effectiveTtl > 0) {
        loadArgs.push("--ttl", String(effectiveTtl));
      }
      if (context_length !== undefined) loadArgs.push("--context-length", String(context_length));
      if (parallel !== undefined) loadArgs.push("--parallel", String(parallel));
      await execFileAsync(lms, loadArgs, { timeout: 300000 });
      steps.push(`Cargado '${model}' (tier=${tierOf(model)}).`);
      logActivity({
        tool: "lm_studio_load_model",
        model,
        tier: tierOf(model),
        exclusive,
        include_remote,
        context_length,
        parallel,
        ok: true,
      });

      const { stdout: ps } = await execFileAsync(lms, ["ps"]);
      return { content: [{ type: "text", text: `${steps.join("\n")}\n\nEstado actual (lms ps):\n${ps.trim()}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = /ENOENT|not found/i.test(msg)
        ? ` No se encontró el CLI 'lms'. Instalalo con LM Studio o seteá LMS_PATH al binario.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `${steps.join("\n")}${steps.length ? "\n" : ""}Falló al cargar '${model}': ${msg}.${hint}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "lm_studio_list_mcp_servers",
  {
    title: "Listar MCPs disponibles para lm_studio_agent",
    description:
      "Lista los nombres de servidor definidos en ~/.lmstudio/mcp.json — usar esos nombres en el parámetro " +
      "'mcp_servers' de lm_studio_agent. No verifica que cada uno esté vivo/alcanzable, solo lista lo que hay " +
      "configurado (url = servidor HTTP remoto; command = proceso local stdio).",
    inputSchema: {},
  },
  async () => {
    const servers = loadLmStudioMcpConfig();
    const names = Object.keys(servers);
    if (!names.length) {
      return { content: [{ type: "text", text: `No hay servers en ${LMSTUDIO_MCP_JSON}.` }] };
    }
    const lines = names.map((name) => {
      const cfg = servers[name];
      return cfg.url ? `${name} (url: ${cfg.url})` : `${name} (command: ${cfg.command})`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "lm_studio_generate",
  {
    title: "Delegar generación a LM Studio (local, gratis)",
    description:
      "Ejecuta un prompt en el modelo local de LM Studio, en vez de gastar tokens de Claude. Por defecto usa " +
      "el modelo que ya está cargado en memoria en la app; si no hay ninguno cargado, dispara JIT-load de " +
      `'${DEFAULT_MODEL}' (LM_STUDIO_DEFAULT_MODEL). Usar para trabajo ` +
      "mecánico o masivo: borradores largos, transformaciones repetitivas, resúmenes, reescritura de texto, " +
      "generación de boilerplate. No usar para tareas que requieran razonamiento complejo, uso de otras " +
      "herramientas, o alta precisión — para eso conviene que Claude lo haga directo. " +
      "Nota sobre modelos con 'thinking' (Qwen3, Gemma, etc.): el server manda reasoning_effort='none', que " +
      "verificado el 2026-08-05 SÍ apaga el razonamiento vía API (0 reasoning_tokens en qwen3.6-35b-a3b y " +
      "gemma-4-26b-a4b-qat). Se mantiene además chat_template_kwargs.enable_thinking=false por compatibilidad, " +
      "pero ese flag por sí solo LM Studio lo ignora vía API/REST: sin reasoning_effort el modelo gasta todo " +
      "max_tokens 'pensando' y devuelve content vacío (era la causa de los reportes de 'respuesta vacía').",
    inputSchema: {
      prompt: z.string().describe("El prompt / tarea a ejecutar en el modelo local."),
      system: z
        .string()
        .optional()
        .describe("Instrucción de sistema opcional (rol, formato de salida, restricciones)."),
      model: z
        .string()
        .optional()
        .describe(
          "ID del modelo a usar (ver lm_studio_list_models). Si se omite, se usa el modelo ya cargado en LM Studio."
        ),
      temperature: z.number().min(0).max(2).optional().default(0.7),
      max_tokens: z.number().int().positive().optional().default(2048),
      response_schema: z
        .record(z.any())
        .optional()
        .describe(
          "JSON Schema opcional. Si se pasa, LM Studio fuerza (grammar-constrained) que la respuesta sea JSON " +
            "válido contra ese schema — no depende de que el modelo 'obedezca' la instrucción en el prompt. " +
            "Usalo para extracción de datos donde necesitás campos exactos (ej. {tools_called, metrics, tool_errors})."
        ),
    },
  },
  async ({ prompt, system, model, temperature, max_tokens, response_schema }) => {
    const startedAt = Date.now();
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ];
    // Tier 'intern': esto es delegación mecánica de texto. Si además del modelo
    // grande hay uno chico residente, se prefiere el chico — no tiene sentido
    // ocupar al sub-agente (lento) en una transformación 1-a-1.
    const resolvedModel = await resolveModel(model, "intern");
    const data = (await lmFetch("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolvedModel,
        ...ttlField(),
        messages,
        temperature,
        max_tokens,
        // reasoning_effort es el que realmente apaga el "thinking" vía API
        // (verificado: 0 reasoning_tokens). enable_thinking se deja por
        // compatibilidad, pero solo LM Studio lo ignora en el server REST.
        reasoning_effort: "none",
        chat_template_kwargs: { enable_thinking: false },
        ...(response_schema
          ? { response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: response_schema } } }
          : {}),
      }),
    })) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
    };

    const choice = data.choices?.[0];
    // Si `content` viene vacío pero hay `reasoning_content`, el modelo gastó el
    // presupuesto pensando y nunca emitió la respuesta. Se devuelve igual (a veces
    // el razonamiento contiene algo aprovechable), pero MARCADO: pasarlo como si
    // fuera la respuesta hace que el caller acepte "pensamiento en voz alta" como
    // entregable — verificado con un modelo sin thinking-off, que devolvió 1557
    // palabras de razonamiento y cero de historia con isError:false.
    const rawContent = choice?.message?.content || "";
    const reasoningOnly = !rawContent && Boolean(choice?.message?.reasoning_content);
    const text = rawContent || choice?.message?.reasoning_content || "";
    if (!text) {
      const reason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : "";
      logActivity({
        tool: "lm_studio_generate",
        model: resolvedModel,
        ms: Date.now() - startedAt,
        ok: false,
        prompt: snippet(prompt),
        error: `sin contenido${reason}`,
      });
      return {
        content: [
          {
            type: "text",
            text: `LM Studio no devolvió contenido${reason}. Probá subir max_tokens (el modelo puede haber gastado el presupuesto pensando).`,
          },
        ],
        isError: true,
      };
    }
    logActivity({
      tool: "lm_studio_generate",
      model: resolvedModel,
      ms: Date.now() - startedAt,
      ok: !reasoningOnly,
      prompt: snippet(prompt),
      chars: text.length,
      ...(reasoningOnly ? { error: "solo reasoning_content, sin respuesta final" } : {}),
    });
    if (reasoningOnly) {
      return {
        content: [
          {
            type: "text",
            text:
              `⚠️ El modelo '${resolvedModel}' NO produjo respuesta: gastó el presupuesto de tokens ` +
              `razonando y 'content' vino vacío. Abajo va el razonamiento crudo — NO lo trates como el ` +
              `entregable. Arreglo: desactivá el thinking de ese modelo (Prompt Template en la app, ` +
              `'{%- set enable_thinking = false %}'); el flag por API no alcanza. O subí max_tokens.\n\n` +
              `--- reasoning_content ---\n${text.trim()}`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: text.trim() }] };
  }
);

interface OpenAiToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

server.registerTool(
  "lm_studio_agent",
  {
    title: "Delegar tarea CON tools reales a LM Studio (local, gratis)",
    description:
      "Como lm_studio_generate, pero el modelo local puede además llamar tools de MCPs reales — no es solo " +
      "texto/código, puede leer archivos, consultar tu base de conocimiento, APIs internas, etc. El bridge se conecta como cliente " +
      "MCP a los servers pedidos en 'mcp_servers' (nombres de ~/.lmstudio/mcp.json — ver " +
      "lm_studio_list_mcp_servers), le pasa sus tools al modelo, ejecuta lo que pida, y repite hasta que " +
      "termine (loop de agente real, no una sola llamada). Usar para investigación/exploración delegable: " +
      "'buscá en el vault X y resumime', 'leé estos archivos y armá un borrador'. Seguí sin usar para tareas " +
      "de alta precisión (bugs/vulnerabilidades, decisiones con impacto real) — el modelo local razona peor " +
      "sobre CUÁNDO y CÓMO usar cada tool, y sobre cuándo parar, que Claude. Verificá el resultado antes de " +
      "confiar en él (ver regla de costo en feedback_intern_delegation / ~/.codex/AGENTS.md). " +
      "La respuesta siempre incluye 'tool_trace' (qué tool se llamó, con qué args, y qué devolvió) — para " +
      "tareas de auditoría/extracción, verificá cada dato del texto contra el trace en vez de confiar en la " +
      "síntesis del modelo: puede redactar algo plausible con números que no vinieron de ninguna tool. Para " +
      "forzar formato exacto, usá 'response_schema'.",
    inputSchema: {
      prompt: z.string().describe("La tarea a ejecutar en el modelo local con acceso a tools."),
      mcp_servers: z
        .array(z.string())
        .min(1)
        .describe(
          "Nombres de servers de ~/.lmstudio/mcp.json a darle al modelo (ver lm_studio_list_mcp_servers). " +
            "Elegí el mínimo necesario para la tarea — cada server conectado agrega tools al contexto del modelo."
        ),
      system: z
        .string()
        .optional()
        .describe("Instrucción de sistema opcional (rol, formato de salida, restricciones)."),
      model: z
        .string()
        .optional()
        .describe(
          "ID del modelo a usar (ver lm_studio_list_models). Si se omite, se usa el modelo ya cargado en LM Studio."
        ),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .default(0.3)
        .describe("Default más bajo que lm_studio_generate — tool-calling es más confiable con menos variación."),
      max_tokens: z.number().int().positive().optional().default(4096),
      max_iterations: z
        .number()
        .int()
        .positive()
        .max(30)
        .optional()
        .default(8)
        .describe("Tope de vueltas del loop (llamada al modelo + ejecución de tools) antes de cortar."),
      response_schema: z
        .record(z.any())
        .optional()
        .describe(
          "JSON Schema opcional. Si se pasa, después de que el modelo termine su exploración libre (con tools), " +
            "se hace UNA llamada extra sin tools que le pide reformatear su respuesta como JSON estricto contra " +
            "ese schema, basado SOLO en lo ya conversado — no se pasa junto con 'tools' porque en la práctica eso " +
            "hace que el modelo prefiera inventar un JSON plausible antes que llamar la tool (verificado empíricamente). " +
            "Devuelve el resultado en el campo 'structured' de la respuesta, junto a 'tool_trace' para auditar cada " +
            "número contra la tool que lo originó — no confíes en el texto libre para datos que necesitás verificar."
        ),
    },
  },
  async ({ prompt, mcp_servers, system, model, temperature, max_tokens, max_iterations, response_schema }, extra) => {
    const startedAt = Date.now();
    const progressToken = extra?._meta?.progressToken;
    const configs = loadLmStudioMcpConfig();
    const missing = mcp_servers.filter((name) => !(name in configs));
    if (missing.length) {
      const available = Object.keys(configs).join(", ") || "(ninguno configurado)";
      return {
        content: [
          {
            type: "text",
            text: `Server(s) no encontrados en ${LMSTUDIO_MCP_JSON}: ${missing.join(", ")}. Disponibles: ${available}`,
          },
        ],
        isError: true,
      };
    }

    const connected: Array<{ name: string; client: Client }> = [];
    const toolRouting = new Map<string, { client: Client; originalName: string }>();
    // biome-ignore lint: schema shape viene directo de cada MCP server, heterogéneo por diseño
    const openAiTools: any[] = [];

    try {
      for (const name of mcp_servers) {
        let client: Client;
        try {
          client = await connectMcpServer(name, configs[name]);
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `No pude conectar al server "${name}": ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
        connected.push({ name, client });
        const { tools } = await client.listTools();
        for (const tool of tools) {
          const pname = prefixedToolName(name, tool.name);
          toolRouting.set(pname, { client, originalName: tool.name });
          openAiTools.push({
            type: "function",
            function: {
              name: pname,
              description: tool.description ?? "",
              parameters: tool.inputSchema ?? { type: "object", properties: {} },
            },
          });
        }
      }

      if (!openAiTools.length) {
        return {
          content: [{ type: "text", text: "Los servers conectados no exponen ninguna tool." }],
          isError: true,
        };
      }

      // biome-ignore lint: mensajes heterogéneos (system/user/assistant+tool_calls/tool)
      const messages: any[] = [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ];
      // Tier 'subagent': un loop de agente con tools necesita el modelo con más
      // capacidad y contexto residente, no el primero que esté cargado. Si el
      // elegido resulta ser de tier 'intern' no se falla — puede ser deliberado —
      // pero se avisa en la respuesta, porque los modos de falla del tool-calling
      // con un modelo chico (inventar tools, no parar nunca) son difíciles de
      // diagnosticar desde el resultado.
      const resolvedModel = await resolveModel(model, "subagent");
      const tierWarning =
        tierOf(resolvedModel) === "subagent"
          ? null
          : `Aviso: '${resolvedModel}' está en el tier 'intern', no 'subagent'. Un loop de agente con tools ` +
            `en un modelo chico tiende a inventar tools o a no parar. Si fue a propósito, ignorá esto; si no, ` +
            `cargá un modelo de tier subagent (lm_studio_list_models) o pasá 'model' explícito.`;

      // Registro de auditoría: qué tool se llamó, con qué args, y qué devolvió
      // (truncado). Se devuelve siempre junto al texto final — el modelo local
      // puede redactar una síntesis plausible con números que nunca vinieron de
      // ninguna tool; con esto el caller puede verificar cada dato en vez de
      // confiar ciegamente en la prosa. Ver MODELS.md sobre este failure mode.
      const TRACE_RESULT_MAX_CHARS = 2000;
      const toolTrace: Array<{ tool: string; args: unknown; result: string; error: boolean }> = [];

      let finalText = "";
      let finishedEarly = false;
      for (let i = 0; i < max_iterations; i++) {
        if (progressToken !== undefined) {
          // Best-effort: solo evita el timeout del lado del cliente si ese
          // cliente pidió resetTimeoutOnProgress al llamar esta tool. No lo
          // controlamos nosotros, pero no cuesta nada emitirlo.
          await extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: i + 1,
                total: max_iterations,
                message: `Iteración ${i + 1}/${max_iterations} del intern-agent`,
              },
            })
            .catch(() => {});
        }
        const data = (await lmFetch("/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: resolvedModel,
            ...ttlField(),
            messages,
            tools: openAiTools,
            tool_choice: "auto",
            temperature,
            max_tokens,
            // Igual que en lm_studio_generate: sin esto el modelo gasta todo
            // max_tokens pensando y devuelve content vacío, lo que corta el
            // loop de tools. Si alguna vez empeora la ELECCIÓN de tools,
            // esta es la línea a revertir (solo acá, no en generate).
            reasoning_effort: "none",
            chat_template_kwargs: { enable_thinking: false },
          }),
        })) as {
          choices?: Array<{
            message?: {
              content?: string | null;
              reasoning_content?: string;
              tool_calls?: OpenAiToolCall[];
            };
            finish_reason?: string;
          }>;
        };

        const message = data.choices?.[0]?.message;
        if (process.env.LM_AGENT_DEBUG) {
          console.error(`[agent-debug] iter=${i} RAW=${JSON.stringify(data.choices?.[0])}`);
        }
        if (!message) {
          finalText = "LM Studio no devolvió respuesta.";
          finishedEarly = true;
          break;
        }

        const toolCalls = message.tool_calls ?? [];
        if (!toolCalls.length) {
          // El modelo terminó (finish_reason stop/length) sin pedir más tools.
          // Puede venir vacío si gastó todo el budget "pensando" pese al flag
          // nothink — distinguir de "se acabaron las iteraciones" más abajo.
          finalText = message.content || message.reasoning_content || "";
          finishedEarly = true;
          break;
        }

        messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });

        for (const call of toolCalls) {
          const routing = toolRouting.get(call.function.name);
          let resultText: string;
          let args: Record<string, unknown> = {};
          let traceArgs: unknown = call.function.arguments;
          let isError = false;
          if (!routing) {
            resultText = `Error: tool "${call.function.name}" no reconocida entre las conectadas.`;
            isError = true;
          } else {
            let argsOk = true;
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
              traceArgs = args;
            } catch {
              resultText = `Error: argumentos inválidos (no es JSON): ${call.function.arguments}`;
              argsOk = false;
              isError = true;
            }
            if (argsOk) {
              try {
                // Timeout más generoso que el default del SDK (60s) — búsquedas
                // semánticas (obsidian-semantic) u otros MCPs pueden tardar más
                // en local sin que sea un cuelgue real.
                const result = await routing.client.callTool(
                  { name: routing.originalName, arguments: args },
                  undefined,
                  { timeout: 120000 }
                );
                const blocks = Array.isArray(result.content) ? result.content : [];
                resultText =
                  blocks
                    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : JSON.stringify(block)))
                    .join("\n") || "(sin contenido)";
                isError = Boolean(result.isError);
              } catch (err) {
                resultText = `Error ejecutando la tool: ${err instanceof Error ? err.message : String(err)}`;
                isError = true;
              }
            } else {
              resultText = `Error: argumentos inválidos (no es JSON): ${call.function.arguments}`;
            }
          }
          if (process.env.LM_AGENT_DEBUG) {
            console.error(`[agent-debug] tool_result name=${call.function.name} -> ${resultText.slice(0, 300)}`);
          }
          toolTrace.push({
            tool: call.function.name,
            args: traceArgs,
            result:
              resultText.length > TRACE_RESULT_MAX_CHARS
                ? `${resultText.slice(0, TRACE_RESULT_MAX_CHARS)}… (truncado, ${resultText.length} chars totales)`
                : resultText,
            error: isError,
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
        }
      }

      if (!finishedEarly) {
        // El for terminó sus max_iterations vueltas y en la última seguía
        // pidiendo tools — ahí sí se agotó el presupuesto de verdad.
        logActivity({
          tool: "lm_studio_agent",
          model: resolvedModel,
          ms: Date.now() - startedAt,
          ok: false,
          prompt: snippet(prompt),
          mcp_servers,
          tool_calls: toolTrace.length,
          error: `sin respuesta final tras ${max_iterations} iteraciones`,
        });
        return {
          content: [
            {
              type: "text",
              text: `Se alcanzó el máximo de ${max_iterations} iteraciones sin respuesta final (el modelo seguía pidiendo tools). Subí max_iterations o simplificá la tarea.\n\ntool_trace: ${JSON.stringify(toolTrace, null, 2)}`,
            },
          ],
          isError: true,
        };
      }
      if (!finalText) {
        logActivity({
          tool: "lm_studio_agent",
          model: resolvedModel,
          ms: Date.now() - startedAt,
          ok: false,
          prompt: snippet(prompt),
          mcp_servers,
          tool_calls: toolTrace.length,
          error: "contenido final vacío",
        });
        return {
          content: [
            {
              type: "text",
              text: "El modelo terminó sin pedir más tools pero devolvió contenido vacío " +
                "(puede haber gastado el budget de tokens 'pensando' pese a nothink). Probá subir max_tokens.\n\n" +
                `tool_trace: ${JSON.stringify(toolTrace, null, 2)}`,
            },
          ],
          isError: true,
        };
      }

      // Si pidieron response_schema, hacer UNA llamada extra sin 'tools' para
      // forzar el formato — combinar response_format+tools en el loop hace que
      // el modelo prefiera inventar un JSON plausible antes que llamar la tool
      // pedida (verificado empíricamente), así que la constricción de schema se
      // aplica recién acá, sobre la conversación ya completa.
      let structured: unknown = null;
      let structuredError: string | null = null;
      if (response_schema) {
        try {
          const structuringMessages = [
            ...messages,
            { role: "assistant", content: finalText },
            {
              role: "user",
              content:
                "Reformateá tu respuesta anterior como JSON estricto contra el schema dado. Basate SOLO en los " +
                "datos que ya reuniste en esta conversación (tus propias tool calls de arriba) — si algo no lo " +
                "verificaste con una tool, no lo incluyas.",
            },
          ];
          const structData = (await lmFetch("/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: resolvedModel,
              ...ttlField(),
              messages: structuringMessages,
              temperature: 0,
              max_tokens,
              chat_template_kwargs: { enable_thinking: false },
              response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: response_schema } },
            }),
          })) as { choices?: Array<{ message?: { content?: string } }> };
          const structText = structData.choices?.[0]?.message?.content ?? "";
          structured = structText ? JSON.parse(structText) : null;
        } catch (err) {
          structuredError = err instanceof Error ? err.message : String(err);
        }
      }

      logActivity({
        tool: "lm_studio_agent",
        model: resolvedModel,
        ms: Date.now() - startedAt,
        ok: true,
        prompt: snippet(prompt),
        mcp_servers,
        tool_calls: toolTrace.length,
        tools_used: [...new Set(toolTrace.map((t) => t.tool))],
        tool_errors: toolTrace.filter((t) => t.error).length,
        chars: finalText.length,
      });

      const envelope = {
        final_text: finalText.trim(),
        structured,
        ...(structuredError ? { structured_error: structuredError } : {}),
        ...(tierWarning ? { tier_warning: tierWarning } : {}),
        tool_trace: toolTrace,
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } finally {
      await Promise.all(connected.map(({ client }) => client.close().catch(() => {})));
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
