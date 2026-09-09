# Local AI provider

God's Eye View's OpenAI Realtime **voice** control (`/api/realtime/token`) always
stays on OpenAI. Every other, non-voice model call — today just the HUD summary
line (`/api/openai/hud-summary`) — goes through a small pluggable provider
(`server/lib/aiProvider.js`) that can target **any** OpenAI-compatible
`chat/completions` endpoint: OpenAI itself (the default, no setup needed), or a
self-hosted server on your own hardware.

Check what's actually active at any time with:

```sh
curl localhost:4207/api/ai/status
```

```json
{ "provider": "local", "model": "mlx-community/Qwen3-30B-A3B-4bit", "baseUrlHost": "oasiss-mac-studio:4000", "healthy": true }
```

`provider` is `none` (no key, OpenAI's own default), `openai`, or `local`. This
endpoint is keyless and read-only — it never returns a key or the full base
URL, only the hostname.

## Configuration

Three env vars, all optional (`.env` or the in-app POWER UP / Provider
Settings panel — see `.env.example`):

| Var | Meaning |
|---|---|
| `AI_BASE_URL` | Base URL of an OpenAI-compatible server. Unset (default) → OpenAI. |
| `AI_API_KEY` | Bearer credential for that server. Optional — most self-hosted servers (LiteLLM, Ollama, vLLM) run unauthenticated on a trusted network. |
| `AI_MODEL` | Model id to request. Falls back to `OPENAI_HUD_SUMMARY_MODEL` (then `gpt-5-nano`) when `AI_BASE_URL` is unset. |

## Mac Studio: `mlx_lm.server` behind LiteLLM

`mlx-lm`'s server already speaks the OpenAI `chat/completions` shape, so
`AI_BASE_URL` could point straight at it — a LiteLLM gateway in front is only
useful once you're also routing to Ollama or a second machine through the same
URL, or want LiteLLM's request logging/budgets.

1. Start MLX itself:

   ```sh
   mlx_lm.server --model mlx-community/Qwen3-30B-A3B-4bit --port 8080
   ```

2. Point LiteLLM at it (`litellm-config.yaml`):

   ```yaml
   model_list:
     - model_name: mlx-community/Qwen3-30B-A3B-4bit
       litellm_params:
         model: openai/mlx-community/Qwen3-30B-A3B-4bit
         api_base: http://localhost:8080/v1
         api_key: "not-needed"
   ```

   ```sh
   litellm --config litellm-config.yaml --port 4000
   ```

3. On the machine running God's Eye View:

   ```sh
   AI_BASE_URL=http://oasiss-mac-studio:4000/v1
   AI_MODEL=mlx-community/Qwen3-30B-A3B-4bit
   ```

## Windows/NVIDIA: Ollama (or vLLM) with CUDA

Ollama's OpenAI-compatible endpoint is on by default:

```sh
ollama pull qwen3:30b
ollama serve
```

```sh
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=qwen3:30b
```

(vLLM's `--api-key` + `python -m vllm.entrypoints.openai.api_server` serves the
same shape at whatever `--port` you give it — point `AI_BASE_URL` at that
instead.)

## Verifying

1. `curl localhost:4207/api/ai/status` — confirm `provider`, `model`, and
   `healthy: true`.
2. `curl -X POST localhost:4207/api/openai/hud-summary -d '{}'` — a `summary`
   (or a `null` summary with an `error` only if the upstream server rejected
   the request) confirms the round trip actually works, not just that the
   port answers.

Nothing set at all is a supported, keyless state: `/api/ai/status` reports
`provider: "none"`, and `/api/openai/hud-summary` returns its existing
`configured: false` capability response (HUD summaries are simply skipped) —
see `src/hudSummaryResponse.js`.
