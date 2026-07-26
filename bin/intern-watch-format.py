#!/usr/bin/env python3
"""Formatea el log JSONL de actividad del intern en líneas legibles.

Se usa desde `intern-watch`; también sirve suelto:
    tail -f ~/.lmstudio/intern-activity.jsonl | python3 intern-watch-format.py
"""
import json
import sys

OK = "\033[32m"
ERR = "\033[31m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue

        ts = e.get("ts", "")[11:19]
        mark = f"{OK}OK {RESET}" if e.get("ok", True) else f"{ERR}ERR{RESET}"
        tool = str(e.get("tool", "?")).replace("lm_studio_", "")
        ms = e.get("ms")
        dur = f"{ms / 1000:.1f}s" if isinstance(ms, (int, float)) else "-"

        bits = [f"{DIM}{ts}{RESET}", mark, f"{BOLD}{tool:<12}{RESET}", f"{dur:>6}"]

        model = e.get("model") or ""
        if model:
            short = model.split("/")[-1][:22]
            bits.append(f"{DIM}{short:<22}{RESET}")

        used = e.get("tools_used")
        if used:
            names = ", ".join(t[:24] for t in used[:3])
            more = "…" if len(used) > 3 else ""
            bits.append(f"[{len(used)} tool(s): {names}{more}]")

        n_err = e.get("tool_errors")
        if isinstance(n_err, int) and n_err > 0:
            bits.append(f"{ERR}{n_err} tool-error(s){RESET}")

        err = e.get("error")
        if err:
            bits.append(f"{ERR}{err}{RESET}")

        prompt = e.get("prompt") or ""
        if prompt:
            bits.append(f"{DIM}{prompt[:70]}{RESET}")

        print("  ".join(bits), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
