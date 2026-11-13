#!/usr/bin/env python3
"""Own only the product MCP and its authenticated HTTPS demo tunnel; never Docker."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".repolead" / "product-demo"


def private_file(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as handle:
        handle.write(text)
    path.chmod(0o600)


def fingerprint(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else fields[19]
    except (OSError, IndexError):
        return None


def alive(process):
    return process and process.get("start") and fingerprint(process["pid"]) == process["start"]


def spawn(args, log, env=None):
    private_file(log, "")
    with log.open("a") as handle:
        process = subprocess.Popen(args, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                   stdout=handle, stderr=handle, start_new_session=True)
    return {"pid": process.pid, "start": fingerprint(process.pid)}


def stop_owned(state):
    for key in ("tunnel", "server"):
        process = state.get(key)
        if alive(process):
            os.kill(process["pid"], signal.SIGTERM)


def request(url, token=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, body, headers), timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "status", "stop"])
    parser.add_argument("--dir", type=Path)
    parser.add_argument("--repos-file", type=Path, help="JSON array of explicitly authorized repository aliases")
    parser.add_argument("--port", type=int, default=3941)
    parser.add_argument("--tunnel", choices=["ngrok", "cloudflared"], default="ngrok")
    parser.add_argument("--reuse-token", action="store_true", help="reuse the existing private demo credential instead of rotating it")
    args = parser.parse_args()
    state_path = STATE / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if args.action == "status":
        print(json.dumps({"url": state.get("url"), "serverRunning": bool(alive(state.get("server"))),
                          "tunnelRunning": bool(alive(state.get("tunnel"))), "credentials": str(STATE / "CONEXION-PRIVADA.md")}, indent=2))
        return
    if args.action == "stop":
        stop_owned(state)
        print("Detenidos únicamente el MCP de la demo y su túnel, si seguían activos.")
        return
    if alive(state.get("server")) or alive(state.get("tunnel")):
        raise SystemExit("La demo ya tiene un proceso activo. Usa status o stop antes de reiniciarla.")
    if not args.dir or not args.repos_file:
        parser.error("start requiere --dir y --repos-file")
    repos = json.loads(args.repos_file.read_text())
    if not isinstance(repos, list) or not repos or any(not isinstance(name, str) or not name or "," in name for name in repos):
        raise SystemExit("repos-file debe contener un array JSON no vacío de aliases sin comas.")
    cli = ROOT / "apps/cli/dist/index.cjs"
    if not cli.exists():
        raise SystemExit("Compila primero: bun run build")
    executable = shutil.which(args.tunnel)
    if not executable and args.tunnel == "cloudflared":
        candidate = ROOT / ".repolead-tools/cloudflared"
        if candidate.is_file():
            executable = str(candidate)
    if not executable:
        raise SystemExit(f"Falta {args.tunnel}; instala su binario oficial o usa --tunnel con el disponible.")
    if args.reuse_token:
        credentials_path = STATE / "credentials.json"
        if not credentials_path.exists():
            raise SystemExit("No hay credencial previa para reutilizar; no se generó otra.")
        token = json.loads(credentials_path.read_text()).get("token")
        if not isinstance(token, str) or len(token) < 32 or any(character.isspace() for character in token):
            raise SystemExit("La credencial previa no es válida; no se reemplazó.")
    else:
        token = secrets.token_urlsafe(48)
    local = f"http://127.0.0.1:{args.port}/mcp"
    env = dict(os.environ, REPOLEAD_TOKEN=token)
    state = {"dir": str(args.dir.resolve()), "repos": repos, "local": local}
    try:
        state["server"] = spawn([shutil.which("node") or "node", str(cli), "serve", "--product", "--http",
                                  "--dir", str(args.dir.resolve()), "--only", ",".join(repos), "--host", "127.0.0.1",
                                  "--port", str(args.port), "--allow-origin", "https://claude.ai"], STATE / "server.log", env)
        private_file(state_path, json.dumps(state, indent=2))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                tools = request(local, token)["result"]["tools"]
                if sorted(tool["name"] for tool in tools) != ["product_catalog", "product_context", "product_evidence", "product_investigate"]:
                    raise SystemExit("El servidor no tiene el catálogo exclusivo de producto.")
                break
            except (OSError, ValueError, KeyError):
                if not alive(state["server"]):
                    raise SystemExit(f"El MCP no arrancó. Revisar {STATE / 'server.log'}")
                time.sleep(0.25)
        else:
            raise SystemExit("El MCP no respondió a tiempo.")
        if args.tunnel == "ngrok":
            command = [executable, "http", f"http://127.0.0.1:{args.port}", "--inspect=false", "--log=stdout", "--log-format=json"]
        else:
            command = [executable, "tunnel", "--url", f"http://127.0.0.1:{args.port}", "--no-autoupdate"]
        state["tunnel"] = spawn(command, STATE / "tunnel.log")
        private_file(state_path, json.dumps(state, indent=2))
        deadline = time.monotonic() + 25
        url = None
        while time.monotonic() < deadline:
            if not alive(state["tunnel"]):
                raise SystemExit(f"El túnel no arrancó. Revisar {STATE / 'tunnel.log'}; el MCP se cerrará sin tocar WLT.")
            if args.tunnel == "ngrok":
                try:
                    with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as response:
                        tunnels = json.load(response).get("tunnels", [])
                    url = next((item["public_url"] for item in tunnels if item["public_url"].startswith("https://")
                                and str(args.port) in str(item.get("config", {}).get("addr", ""))), None)
                except (OSError, ValueError):
                    pass
            else:
                import re
                match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", (STATE / "tunnel.log").read_text())
                url = match.group() if match else None
            if url:
                break
            time.sleep(0.5)
        if not url:
            raise SystemExit("No se obtuvo URL HTTPS del túnel a tiempo.")
        state["url"] = url + "/mcp"
        private_file(state_path, json.dumps(state, indent=2))
        # The credentials never appear in command arguments, source control, URL or stdout.
        private_file(STATE / "credentials.json", json.dumps({"url": state["url"], "token": token}, indent=2))
        private_file(STATE / "CONEXION-PRIVADA.md", f"""# Conexión privada — demo RepoLead Producto

Compartir solo con los participantes de la prueba. No adjuntar a PRDs ni subir a Git.

- Nombre del conector: **RepoLead Producto**
- URL MCP: `{state['url']}`
- Autenticación: **No sign in** (credencial fija, sin OAuth en esta demo)
- Request headers → nombre: `Authorization`
- Request headers → valor: `Bearer {token}`

En Claude Desktop / Cowork: Customize → Connectors → Add custom connector. En Team/Enterprise, un Owner configura el conector de la organización. Agregar la URL; en Authentication elegir No sign in y en Request headers agregar el encabezado anterior. Habilitar el conector en la conversación y abrir la sesión con el plugin de demo instalado.

La cuenta llega solo a los repositorios de la lista autorizada. Token compartido de demo; no ofrece permisos individuales de la aplicación. Para detener el acceso: `python3 scripts/product-demo.py stop`. Un nuevo start genera otra credencial salvo que se indique `--reuse-token`. El túnel temporal puede cambiar de URL aunque se conserve el token. La computadora y ambos procesos deben seguir encendidos.

Guía: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
""")
        # Verify the actual public endpoint; retry briefly while the tunnel DNS propagates.
        deadline = time.monotonic() + 15
        while True:
            try:
                if len(request(state["url"], token)["result"]["tools"]) != 4:
                    raise SystemExit("Catálogo público inesperado.")
                break
            except (OSError, ValueError, KeyError):
                if time.monotonic() >= deadline:
                    raise SystemExit("El endpoint público no respondió a la verificación.")
                time.sleep(0.5)
        print(f"Demo HTTPS lista: {state['url']}")
        print(f"Conexión y token en {STATE / 'CONEXION-PRIVADA.md'} (archivo privado).")
    except BaseException:
        stop_owned(state)
        raise


if __name__ == "__main__":
    main()
