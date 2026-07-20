#!/usr/bin/env bash
# Instalador de llm-Intern: compila el bridge y (opcional) lo registra en
# Claude Code. No toca la config de Codex ni tu CLAUDE.md automáticamente —
# eso queda en docs/codex-setup.md y docs/claude-code-setup.md a propósito,
# porque son archivos personales tuyos y prefiero no auto-editarlos.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
REPO_DIR="$(pwd)"

echo "== llm-Intern install =="
echo "Repo: $REPO_DIR"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Falta Node.js. Instalalo (https://nodejs.org/) y volvé a correr este script." >&2
  exit 1
fi
echo "node: $(node -v)"

if ! curl -s -m 3 http://localhost:1234/v1/models >/dev/null 2>&1; then
  echo
  echo "AVISO: no pude conectar a LM Studio en http://localhost:1234."
  echo "  Abrí LM Studio, cargá un modelo (ver MODELS.md) y activá el servidor local"
  echo "  (pestaña Developer -> Start Server) antes de usar el bridge."
fi

echo
echo "-- Instalando dependencias --"
npm install

echo
echo "-- Compilando --"
npm run build

echo
echo "-- Registro en Claude Code --"
if command -v claude >/dev/null 2>&1; then
  read -r -p "¿Registrar el MCP server en Claude Code ahora (claude mcp add --scope user lm-studio)? [y/N] " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    claude mcp add --scope user lm-studio -- node "$REPO_DIR/dist/index.js"
    echo "Registrado. Si tenías una sesión de Claude Code ya abierta, reiniciala para que cargue las tools."
  else
    echo "Salteado. Para hacerlo después:"
    echo "  claude mcp add --scope user lm-studio -- node \"$REPO_DIR/dist/index.js\""
  fi
else
  echo "No encontré el CLI 'claude' en el PATH. Instrucciones manuales en docs/claude-code-setup.md."
fi

echo
echo "-- OpenClaw (agente main) --"
if [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
  echo "Detecté ~/.openclaw/openclaw.json. El registro en OpenClaw es MANUAL a propósito"
  echo "(es un archivo vivo de un gateway en ejecución — no lo auto-edito)."
  echo "Agregá este server dentro de mcp.servers (ver templates/openclaw-mcp.snippet.json):"
  echo
  echo "    \"lm-studio\": {"
  echo "      \"command\": \"node\","
  echo "      \"args\": [\"$REPO_DIR/dist/index.js\"],"
  echo "      \"env\": { \"LM_STUDIO_DEFAULT_MODEL\": \"qwen/qwen3.6-35b-a3b\" }"
  echo "    }"
  echo
  echo "Backup antes de editar: cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak"
  echo "Luego reiniciá el gateway de OpenClaw. Detalle en docs/openclaw-setup.md."
fi

echo
echo "== Listo =="
echo "Próximos pasos (manuales, ver docs/ para el detalle):"
echo "  1. Codex: agregá el bloque [mcp_servers.lm-studio] a ~/.codex/config.toml (docs/codex-setup.md)"
echo "  2. Pegá templates/CLAUDE.snippet.md en ~/.claude/CLAUDE.md (reemplazando los placeholders)"
echo "  3. Pegá templates/AGENTS.snippet.md en ~/.codex/AGENTS.md (reemplazando los placeholders)"
echo "  4. OpenClaw main: registrá el MCP (arriba) y pegá templates/openclaw.snippet.md en el AGENTS.md del main (docs/openclaw-setup.md)"
echo "  5. Opcional: cp -r .claude/skills/intern ~/.claude/skills/intern"
echo "  6. cp templates/mcp.example.json ~/.lmstudio/mcp.json y adaptalo (si vas a usar lm_studio_agent)"
echo "  7. Verificá: node smoke-test.mjs"
