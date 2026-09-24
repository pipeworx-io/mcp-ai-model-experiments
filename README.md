# @pipeworx/ai-model-experiments

**Model Lab** — run the same prompt(s) across many AI models at once (Anthropic,
OpenAI, Google, Meta, Mistral, DeepSeek, Qwen and more via OpenRouter) and
compare their outputs, cost, and latency side by side, with an optional
AI-written comparison summary when the run completes.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `experiment_models(search?, min_context?, max_price_per_mtok?, limit?)` — browse ~300 available model ids with context window and our billed per-token price (provider cost × 1.5). Use the returned ids in `experiment_create`.
- `experiment_estimate(prompts[], models[], reps?, params?, summary?)` — free dry-run: cell count + estimated billed cost range for a spec, before creating it.
- `experiment_create(name?, prompts[], models[], reps?, params?, summary?, max_spend_usd)` — creates and starts an experiment (prompts × models × reps). **Async**: returns `experiment_id` immediately; execution happens on a separate cron worker within ~1 minute. Requires prepaid balance ≥ `max_spend_usd`.
- `experiment_status(experiment_id)` — cell counts by state, spend vs cap, whether complete. Poll this after create.
- `experiment_results(experiment_id, include_outputs?)` — per-model aggregates (latency, tokens, cost, error rate), per-cell outputs, and the AI-written comparison summary.
- `experiment_list(limit?)` — caller's experiments, newest first.
- `experiment_cancel(experiment_id)` — skips pending cells (unbilled); in-flight cells finish and bill.
- `experiment_topup(amount_usd?)` — current balance + the x402 top-up flow.

## Auth

**Prepaid only — no free tier, no BYO-key mode.** Every call to `experiment_create`
requires a Pipeworx platform credit balance ≥ `max_spend_usd` (1 credit = $0.0001).
Top up via x402: `POST https://gateway.pipeworx.io/credits/topup?amount_usd=N`
returns an HTTP 402 payment challenge (USDC on Base); retry with a
`PAYMENT-SIGNATURE` header to settle, and credits land instantly. See
`experiment_topup` for the exact flow and current balance.

Billing is **provider cost × 1.5**, floored at $0.10/experiment. Model prices
returned by `experiment_models` are already the billed (marked-up) price, never
the raw provider cost.

Execution is handled by a separate cron worker (`workers/experiment-runner`,
fires every minute) — a created experiment is not synchronous. Poll
`experiment_status` rather than expecting `experiment_create` to block until
done.

## Data sources

- <https://openrouter.ai/api/v1/models> — the model catalog (id, context window, provider pricing) that `experiment_models` wraps and re-prices.
- Inference for each cell is executed against OpenRouter's chat completions API by `workers/experiment-runner`, which also reads OpenRouter's `/generation` endpoint for the actual per-call cost so the 1.5× markup is billed on real cost, not an estimate.

Full build plan, architecture, and current live-vs-planned status:
`docs/model-lab-plan.md`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ai-model-experiments": {
      "url": "https://gateway.pipeworx.io/ai-model-experiments/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ai-model-experiments/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/experiment_models \
  -H 'Content-Type: application/json' \
  -d '{"search":"claude","min_context":100000}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/experiment_models`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ai-model-experiments": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ai-model-experiments"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ai-model-experiments
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ai Model Experiments data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
