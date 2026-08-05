# haven-proxy

Use the **Haven** API from **OpenCode** and any other OpenAI-compatible client without weakening
Haven's privacy model: prompts are end-to-end encrypted to the inference enclave, and the
encryption happens on your machine. Under the hood it's an in-process OpenCode / AI SDK provider
plus a localhost HTTP proxy for baseURL-only tools, sharing one relay core — details in
[Why this exists](#why-this-exists).

## Getting started

Everything below needs a Haven API key (`hvn1_…`) with a positive balance — see
[Get a key and fund it](#get-a-key-and-fund-it).

### Desktop app (easiest)

Download the installer for your OS from [Releases](../../releases) —
`HavenProxy-Setup-<version>.exe`, `HavenProxy-<version>.dmg` or `HavenProxy-<version>.AppImage` —
and run it. First run asks for your `hvn1_…` key, and with the default **Register with OpenCode**
setting left on, that's it: start `opencode` and pick any `haven/…` model. More in
[Desktop app](#desktop-app).

### Standalone executable

Download the single-file binary for your platform from [Releases](../../releases) — no Node
required — then:

```bash
./haven-proxy-win-x64.exe login        # paste your key once — also registers the OpenCode providers
./haven-proxy-win-x64.exe start        # optional: background HTTP proxy for baseURL-only tools
./haven-proxy-win-x64.exe startup on   # optional: start at login (Windows)
```

More in [Standalone executable (no Node required)](#standalone-executable-no-node-required).

### From the repository

Needs Node — see [Requirements](#requirements).

```bash
git clone https://github.com/jan3dev/haven-proxy && cd haven-proxy
npm install
node src/index.js login    # save your key + register the OpenCode providers
npm start                  # run the HTTP proxy in the foreground
```

Prefer a `.env` file instead of `login`? `cp .env.example .env` and edit — see
[Configuration](#configuration).

## Get a key and fund it

```bash
# 1. Create a payment request for a new key (choose asset: LBTC or USDt, and usd_amount):
curl -X POST https://ankara.aquabtc.com/api/v1/haven/purchase/ \
  -H "Content-Type: application/json" \
  -d '{"asset":"LBTC","usd_amount":"5.00"}'

# 2. Sign the returned Liquid tx in AQUA, then submit it to mint the key (shown once):
curl -X POST https://ankara.aquabtc.com/api/v1/haven/purchase/submit/ \
  -H "Content-Type: application/json" \
  -d '{"raw_tx":"<signed-hex>"}'

# Check balance:
curl https://ankara.aquabtc.com/api/v1/haven/account/ -H "X-Api-Key: hvn1_…"
```

Top-ups for an existing key use the same Liquid payment flow (`POST /api/v1/haven/topup/` → sign → `POST /api/v1/haven/topup/submit/`).
For local testing, credit `HavenProfile.usd_balance` directly via the Django admin/shell.

## Desktop app

`app/` contains an Electron tray app for people who don't want a CLI at all: it runs the same
proxy in-process and puts an icon in the system tray — no terminal, no console window, ever.

- **First run** asks for your `hvn1_…` key, verifies it, and stores it in the same
  `~/.haven-proxy/config.json` the CLI uses (and registers the OpenCode provider, like
  `haven-proxy login`).
- **Tray menu**: status + balance, Start/Stop proxy, **Launch at login** toggle, **Register with
  OpenCode** toggle (persisted — unchecking keeps the Haven entries out across restarts), Open
  logs, Settings, Quit.
- **OpenCode doesn't need the proxy running**: `haven/…` models relay in-process, so they work
  with the app closed. The tray proxy exists for baseURL-only tools (`haven-local/…`, Cline,
  Aider, Continue, …).
- The Windows installer asks whether to register Haven with OpenCode; on macOS/Linux it defaults
  to yes and can be toggled in the tray menu.
- If a CLI-started proxy already owns port 3301, the app shows "Running — CLI instance" instead
  of fighting for the port.
- Installers per OS are built by CI (`HavenProxy-Setup-*.exe`, `HavenProxy-*.dmg`,
  `HavenProxy-*.AppImage`) — unsigned for now, same SmartScreen/Gatekeeper caveats as the
  [standalone executable](#standalone-executable-no-node-required).

Develop/build locally:

```bash
npm ci                # root deps first (app symlinks this package)
cd app && npm install
npm start             # dev run (tray icon, console attached — packaged builds have none)
npm run dist          # → app/dist/HavenProxy-Setup-<version>.exe (or .dmg / .AppImage)
```

Don't enable both the app's "Launch at login" and the CLI's `haven-proxy startup on` — they'd
race for the port at login (the app warns about this).

## Use with OpenCode (recommended — no daemon)

OpenCode loads a custom provider package in-process, so it can run the encryption itself with **no
proxy process**. This package's provider export (`createHaven`) is an `@ai-sdk/openai-compatible`
provider whose HTTP layer is a custom `fetch` that does the Haven relay (attest + HPKE-encrypt +
decrypt) locally and injects `X-Api-Key` itself.

Run `haven-proxy login` once — it saves your key to `~/.haven-proxy/config.json` (mode 0600) and
registers the Haven providers in your global OpenCode config, the same way every other OpenCode
provider works. No env var, no manual JSON editing. Restart OpenCode, then pick any `haven/…` model
from any directory.

OpenCode's global config lives at **`~/.config/opencode/opencode.json` on every platform** — on
Windows that is `C:\Users\<you>\.config\opencode\opencode.json`, *not* `%APPDATA%`. `$OPENCODE_CONFIG`,
`$OPENCODE_CONFIG_DIR` and `$XDG_CONFIG_HOME` are honored if you've set them.

`haven-proxy logout` reverses both: removes the saved key and removes the provider entries.

Two entries get written, because there are two ways to reach Haven:

| Provider | How it works | Needs a running proxy? |
| --- | --- | --- |
| `haven/…` | in-process — OpenCode loads this package and relays itself | no |
| `haven-local/…` | plain HTTP to the bundled localhost proxy on `127.0.0.1:3301` | yes (`haven-proxy start` or the tray app) |

Prefer `haven/…` — the relay runs inside OpenCode, so neither the CLI daemon nor the tray app
needs to be running for those models. Pass `--port` to `login` if you run the proxy somewhere
other than 3301.

**Manual setup** (if you prefer to manage `opencode.json` yourself, e.g. in a project file):

```json
{
  "provider": {
    "haven": {
      "npm": "github:jan3dev/haven-proxy#semver:0.x",
      "name": "Haven",
      "models": {
        "gpt-oss-120b": { "name": "GPT-OSS 120B (Haven)", "limit": { "context": 131072, "output": 32768 }, "cost": { "input": 1.80, "output": 6.30 } },
        "kimi-k2-6": { "name": "Kimi K2.6 (Haven)", "limit": { "context": 200000, "output": 65536 }, "cost": { "input": 1.80, "output": 6.30 } },
        "glm-5-2": { "name": "GLM-5.2 (Haven)", "limit": { "context": 200000, "output": 65536 }, "cost": { "input": 1.80, "output": 6.30 } },
        "gemma4-31b": { "name": "Gemma 4 31B (Haven)", "limit": { "context": 131072, "output": 32768 }, "cost": { "input": 1.80, "output": 6.30 } },
        "llama3-3-70b": { "name": "Llama 3.3 70B (Haven)", "limit": { "context": 131072, "output": 32768 }, "cost": { "input": 1.80, "output": 6.30 } },
        "qwen3-vl-30b": { "name": "Qwen3-VL 30B (Haven)", "limit": { "context": 131072, "output": 32768 }, "cost": { "input": 1.80, "output": 6.30 } }
      }
    }
  }
}
```

- `npm` is how OpenCode resolves the package — it uses the same specifiers as `npm install`.
`"github:jan3dev/haven-proxy#semver:0.x"` installs the latest 0.x release tag directly from the
public GitHub repo (no npm publish needed).
- `options.baseURL` is optional — defaults to `https://ankara.aquabtc.com/api/v1/haven`. Override
only for staging or local dev.
- `options.apiKey` is deliberately **absent**: the provider resolves your `hvn1_…` key from the
`HAVEN_API_KEY` env var, then from `~/.haven-proxy/config.json`, so the key never lands in a config
file you share or commit. Set it explicitly only if you want a different key per project.

Restart OpenCode after editing, then pick the `haven/gpt-oss-120b` model.

> If a project-level `opencode.json` (or a global `opencode.jsonc`) also defines a `haven` provider,
> it overrides the global entry — OpenCode merges `config.json` → `opencode.json` → `opencode.jsonc`,
> then project configs found walking up from the cwd. `haven-proxy login` warns when it spots one.

> The `limit` values are best-effort defaults — adjust them to each model's real context/output
> window if you hit truncation. `cost` is USD per 1M tokens and drives OpenCode's session cost
> display. The values above are fallback defaults: `haven-proxy login` (and the tray app on
> startup) fetches the current prices from the backend's public pricing endpoint and writes those
> instead, so re-run `login` (or restart the tray app) to pick up a price change.



## Use with other OpenAI-compatible tools (HTTP proxy)

Tools that only accept a `baseURL` (Cline, Aider, Continue, Zed, …) can't load a provider package,
so run the bundled localhost proxy — it uses the **same relay core** and exposes a plain
OpenAI-compatible endpoint.

**Install globally** (once):

```bash
npm install -g github:jan3dev/haven-proxy#semver:0.x
```

**Save your API key** (once — stored at `~/.haven-proxy/config.json`, mode 0600):

```bash
haven-proxy login
# prompts for the key with hidden input (recommended)
# or pass it directly for scripting/CI:
haven-proxy login --api-key hvn1_…
```

**Run (foreground):**

```bash
haven-proxy
```

**Run in the background** (all platforms — spawns a detached process, logs to `~/.haven-proxy/proxy.log`):

```bash
haven-proxy start             # start in the background (accepts the same flags as serve)
haven-proxy status            # pid, endpoint, key balance
haven-proxy stop              # stop the background proxy
haven-proxy startup on        # also start it automatically at login (Windows; off to undo)
```

`start` refuses to double-start (it probes `/health` first) and prints the log path on failure.
Prefer `login` over passing `--api-key` to `start` — command-line flags are visible in process
listings. If you'd rather manage the process yourself, PM2 still works
(`pm2 start haven-proxy -- serve`), as do `nohup` / `Start-Process`.

**Other commands:**

```bash
haven-proxy validate          # check key validity and account balance
haven-proxy logout            # remove saved credentials
haven-proxy --help            # show all options
```

Credentials are resolved in this order: `--api-key` flag → `HAVEN_API_KEY` env var → `~/.haven-proxy/config.json`. The `.env` / `npm start` flow still works unchanged for existing setups.

**Proxy flags** (all optional — override env vars and saved config):

```
-k, --api-key      hvn1_…   Haven API key              [env: HAVEN_API_KEY]
-u, --base-url     <url>    Ankara origin              [env: HAVEN_BASE_URL] (default: https://ankara.aquabtc.com)
-p, --port         <n>      Port to listen on          [env: PORT]           (default: 3301)
-H, --host         <host>   Host to bind to            [env: HOST]           (default: 127.0.0.1)
-m, --models       <list>   Comma-separated model ids  [env: HAVEN_MODELS]
-t, --timeout      <ms>     Per-request deadline       [env: HAVEN_TIMEOUT_MS] (default: 300000)
    --allow-remote          Allow non-loopback binding [env: HAVEN_ALLOW_REMOTE=1]
```

Smoke test:

```bash
curl http://127.0.0.1:3301/v1/models

curl -N http://127.0.0.1:3301/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss-120b","stream":true,"messages":[{"role":"user","content":"Say hi in one sentence."}]}'
# → SSE chunks, then: data: [DONE]
```

Point any OpenAI-compatible client at `http://127.0.0.1:3301/v1` with any dummy API key (the real
`hvn1_` secret stays in the proxy's `.env`).

## Configuration

Settings resolve in this order: CLI flags → environment variables → saved config
(`~/.haven-proxy/config.json`). When running from the repository, `npm start` also reads a `.env`
file (`cp .env.example .env`, then edit):

| Var                | Meaning                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HAVEN_BASE_URL`   | Origin of the Ankara backend serving Haven. Defaults to `https://ankara.aquabtc.com`. Override for staging/local dev. **HTTPS required** — the SDK refuses to fetch the attestation bundle over plaintext.                                                                       |
| `HAVEN_API_KEY`    | Your `hvn1_…` key. Lives **only** here, never in `opencode.json`.                                                                                                                                                                                                                |
| `HOST` / `PORT`    | Where the proxy listens. Defaults `127.0.0.1:3301`.                                                                                                                                                                                                                              |
| `HAVEN_MODELS`     | Comma-separated model ids exposed at `/v1/models`. Available on Haven: `gpt-oss-120b`, `kimi-k2-6`, `glm-5-2`, `gemma4-31b`, `llama3-3-70b`, `qwen3-vl-30b`. Must match an `id` the enclave actually serves — note the ids use `-`, not `.` (e.g. `kimi-k2-6`, not `kimi-k2.6`). |
| `HAVEN_TIMEOUT_MS` | Per-request upstream deadline in ms (default `300000`). A hung enclave call is cut off with HTTP 504 instead of hanging forever. The in-process provider takes the same value as `options.timeoutMs`.                                                                            |

## Standalone executable (no Node required)

Every [GitHub Release](../../releases) ships single-file binaries built with Node's
[Single Executable Application](https://nodejs.org/api/single-executable-applications.html) support —
the full proxy CLI with the Node runtime baked in:

| Platform | File |
| --- | --- |
| Windows x64 | `haven-proxy-win-x64.exe` |
| macOS (Apple Silicon) | `haven-proxy-macos-arm64` |
| Linux x64 | `haven-proxy-linux-x64` |

```bash
# macOS / Linux: make it executable first
chmod +x haven-proxy-macos-arm64
```

All CLI commands work identically to the npm install and share the same
`~/.haven-proxy/config.json`, so the binary and a CLI install can coexist.

**Unsigned-binary warnings** (signing is a planned follow-up):

- **Windows SmartScreen** may warn on first run — "More info → Run anyway".
- **macOS Gatekeeper** quarantines browser downloads: right-click → Open once, or
  `xattr -d com.apple.quarantine haven-proxy-macos-arm64`.

To build locally instead: `npm ci && npm run build:exe` → `dist/haven-proxy(.exe)` for the
platform you're on (SEA doesn't cross-compile; CI builds each OS on its own runner).

## Why this exists

Haven's `chat/completions` endpoint is deliberately an **opaque EHBP relay**: the client
HPKE-encrypts the request body end-to-end to the inference enclave, and Haven only injects the real
upstream API key and meters tokens from usage the enclave reports out of band — it never sees your
prompt or the completion. OpenCode, on the other hand, speaks plaintext OpenAI: it POSTs JSON and
expects JSON/SSE back. It cannot encrypt a body to an enclave.

Rather than make Haven decrypt server-side (which would mean Haven reads every prompt — a trust
change), this proxy runs the `SecureClient` SDK **on your machine**. OpenCode talks plaintext to
`localhost`; the proxy attests the enclave, encrypts/decrypts locally, and relays ciphertext through
Haven. The encryption boundary stays on your machine. It is essentially a headless version of the
in-repo `templates/haven/verify_console.html`.

```
OpenCode ──plaintext OpenAI──▶  haven-proxy (localhost:3301)  ──EHBP/HPKE──▶  Haven  ──▶ enclave
                    ◀──── plaintext JSON / SSE ────  decrypt        ◀── ciphertext + usage header ──
```

## Trust note

This proxy keeps Haven's "we never see your prompts" guarantee intact. The alternative — a plaintext
OpenAI endpoint on Haven itself — would let the backend read all prompts/completions and is a
**team trust decision**, intentionally not implemented here.

## Requirements

- Node 20.12+ (the SecureClient SDK needs 20; `AbortSignal.any` requires 20.3; `process.loadEnvFile` requires 20.12) —
  **or no Node at all** with the [standalone executable](#standalone-executable-no-node-required).
- A Haven API key (`hvn1_…`) with a positive balance.
