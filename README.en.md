# ECharts Agent

[简体中文](README.md) · **English**

Turn structured data into chart images you can save immediately. ECharts Agent is a self-hosted, single-container service that accepts data over HTTP, MCP, or A2A and returns **SVG / PNG** images. It supports **12 static chart types**, with optional language-model integration for describing charts in natural language.

Use it with AI agents, report generators, and backend applications. Basic rendering needs no model, browser, or database. Images are returned directly to the caller; object storage is not required.

**Already deployed and want to draw charts from your own agent?** Use the [copyable skill prompts below](#use-skills-in-your-agent). For manual configuration, see the [consumer guide](docs/consumer-guide.en.md).

## Choose an input method

| What you have | Input method | Model required? |
| --- | --- | --- |
| Data and a specific chart type | ChartSpec: choose a type and map data fields | No |
| An ECharts JSON option | Render an option within the supported subset | No |
| Data and a description of the chart | Natural-language generation: let the model choose the type and field mappings | Yes |

The model does not generate business data. The service binds the original data to the chart plan. Perform aggregation, completion, and cleaning before submitting your data.

## Use skills in your agent

The repository includes two consumer skills for hosts that support Agent Skills, such as Codex and Claude Code:

| Skill | Purpose |
| --- | --- |
| [echarts-agent-connect](skills/echarts-agent-connect/SKILL.md) | Connect to a deployed service, check authentication and capabilities, and generate a sample chart |
| [echarts-agent-chart](skills/echarts-agent-chart/SKILL.md) | Prepare data, choose charts, save SVG/PNG images, and revise them on request |

**Install and connect:** Copy this prompt to your agent, replacing `https://charts.example.com` with your service address as reachable from the agent's environment:

```text
Please install the echarts-agent-chart and echarts-agent-connect skills from https://github.com/breakstring/echarts-agent/tree/main/skills.
Use this agent host's skill installation method and install both complete directories, including their scripts, references, and examples.
Then use the echarts-agent-connect skill to connect to my deployed ECharts Agent service at https://charts.example.com.
Prefer MCP when this host supports it; if A2A is already available or only HTTP is supported, follow the skill's corresponding path. Reuse securely configured authentication. If credentials are missing, guide me to configure them through the host's secret settings or local environment; do not ask me to paste secrets into chat.
Query the service capabilities and generate a sample PNG using synthetic data to verify both the connection and chart rendering.
```

**Create a chart:** Once connected, give your agent a data file and a request such as:

```text
Use the echarts-agent-chart skill to aggregate sales in this CSV by month, preserve the original currency unit, and create a report-ready bar chart. Save it as monthly-sales.png and keep the reusable request file.
```

For a revision, say: “Make the previous chart horizontal, keep the data and units, and save it separately as monthly-sales-horizontal.png.” For ordinary charting, your agent chooses the chart and the service renders it; no server-side LLM is required.

Skills provide guidance; the host still needs the corresponding network access and image-saving capabilities. Refresh skills or start a new session as required by your host. See the [consumer guide](docs/consumer-guide.en.md) for manual installation paths, Codex/Claude Code configuration, and detailed MCP/A2A/HTTP instructions.

## Quick start

Requires **Node.js 24.16.x** and npm. These commands run an anonymous local service without calling a model.

```bash
git clone https://github.com/breakstring/echarts-agent.git
cd echarts-agent
npm ci
ALLOW_ANONYMOUS=true HOST=127.0.0.1 LLM_ENABLED=false npm run dev
```

In another terminal, enter the project directory and create your first image:

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/charts \
  -H 'Content-Type: application/json' \
  --data-binary @examples/chart.json \
  --output chart.png
```

Open `chart.png` to view the result. Check service readiness:

```bash
curl --fail-with-body http://127.0.0.1:3000/health/ready
```

`npm run dev` builds the code and loads an existing `.env.local`. If that file sets `SERVICE_API_KEY`, requests still require Bearer authentication, even with `ALLOW_ANONYMOUS=true`.

## Run with Docker

### Use the prebuilt GHCR image

Release image: `ghcr.io/breakstring/echarts-agent`, supporting Linux AMD64 and ARM64. Once the package is Public, no login is required:

```bash
docker pull ghcr.io/breakstring/echarts-agent:0.2.0
docker run --rm --name echarts-agent \
  -p 127.0.0.1:3000:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 768m --cpus 2 --pids-limit 128 \
  -e ALLOW_ANONYMOUS=true -e LLM_ENABLED=false \
  ghcr.io/breakstring/echarts-agent:0.2.0
```

`latest` points to the most recently published stable release. Use a version tag or digest for reproducible deployments. Package visibility is separate from repository visibility. If pulling requires authentication after the first publish, the maintainer should make the package Public using the [release guide](docs/container-release.md).

### Use Docker Compose

The generic `compose.yaml` uses a prebuilt image, contains no server, domain, or proxy settings, and publishes no host ports. Put deployment configuration in the Git-ignored `compose.override.yaml`, for example:

```yaml
services:
  echarts-agent:
    environment:
      SERVICE_API_KEY: "replace-with-a-random-secret"
      LLM_ENABLED: "false"
    ports:
      - "127.0.0.1:3000:3000"
```

```bash
chmod 600 compose.override.yaml
ECHARTS_AGENT_IMAGE=ghcr.io/breakstring/echarts-agent:0.2.0 docker compose up -d --no-build --wait
```

Model environment variables can also go in the override's `environment`; this Compose configuration does not read `.env.local`. Escape literal `$` characters as `$$` to prevent Compose interpolation. For internal deployments, configure a shared network in the private override. Explicit anonymous access also requires clearing `SERVICE_API_KEY`. Keep server, network, and Traefik settings in the private override.

### Build from source

Build and start the container from the project root:

```bash
docker build -t echarts-agent:local .
docker run --rm --name echarts-agent \
  -p 127.0.0.1:3000:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 768m --cpus 2 --pids-limit 128 \
  -e ALLOW_ANONYMOUS=true -e LLM_ENABLED=false \
  echarts-agent:local
```

Use the same HTTP requests after startup. The image includes a Chinese font and runs as a non-root user. No browser installation is needed. The example binds the published port to the local machine only.

For access from other services, set a random `SERVICE_API_KEY` through an environment variable or secret and authenticate with a Bearer header. Use the same value on the client and server:

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/capabilities \
  -H "Authorization: Bearer $SERVICE_API_KEY"
```

Model settings can also be injected as environment variables. To use a Node-format `.env.local`, mount it read-only and let Node parse it:

```bash
docker run --rm --name echarts-agent \
  -p 127.0.0.1:3000:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 768m --cpus 2 --pids-limit 128 \
  --mount type=bind,src="$PWD/.env.local",dst=/run/provider.env,readonly \
  echarts-agent:local node --env-file=/run/provider.env dist/main.js
```

The container user must be able to read the file. Configure either `SERVICE_API_KEY` or explicit local anonymous mode. Do not bake real keys into the image or commit them to Git. Docker `--env-file` and Node handle quoting differently; the mount example uses Node's parser.

## Supported charts

| Type | Chart | Main field mappings | Use case |
| --- | --- | --- | --- |
| `bar` | Bar | `x`, `y:[]` | Category comparisons; horizontal and stacked variants |
| `line` | Line | `x`, `y:[]` | Trends; area and stacked variants |
| `pie` | Pie / donut | `name`, `value` | Parts of a whole |
| `scatter` | Scatter | `x`, `y` | Relationships between two numeric fields |
| `radar` | Radar | `name`, `metrics:[]` | Comparing at least three non-negative metrics |
| `gauge` | Gauge | `name`, `value` | One value within a defined range |
| `funnel` | Funnel | `name`, `value` | Stage values in input order |
| `heatmap` | Heatmap | `x`, `y`, `value` | Values across two categorical dimensions |
| `tree` | Tree | `id`, `parent`, `name` | Hierarchical relationships; optional `value` |
| `treemap` | Treemap | `id`, `parent`, `name`, `value` | Hierarchical area distribution |
| `sunburst` | Sunburst | `id`, `parent`, `name`, `value` | Hierarchical proportions in rings |
| `sankey` | Sankey | `source`, `target`, `value` | Acyclic flows with positive values |

Mapping values refer to your data column names; you do not need to rename your columns. See the [basic request](examples/chart.json) and [seven additional chart examples](examples/extended/README.md).

Data requirements:

- `data` is a non-empty array of objects. Cells must be strings or finite numbers. `null` and missing referenced fields are rejected.
- No implicit aggregation, sorting, or filling. Bar/line categories must be unique, and heatmap coordinates cannot repeat.
- Hierarchical charts use a node table with unique `id` values. The root has `parent: ""`; other parents must exist. Exactly one root is required, with no cycles. Treemap and sunburst require non-negative `value` fields; a parent's value cannot be smaller than the sum of its direct children.
- Sankey charts use an edge table with positive flow values. Duplicate edges, self-loops, and directed cycles are rejected.
- Gauges accept exactly one row and default to a 0–100 range. `unit` is a display suffix only: `0.78` is not automatically converted to `78%`.

## HTTP API

When a service key is configured, every endpoint except health checks requires `Authorization: Bearer <SERVICE_API_KEY>`.

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /v1/charts` | `{spec, style?, output?}` | SVG / PNG image bytes |
| `POST /v1/render` | `{option, style?, output?}` | SVG / PNG image bytes |
| `POST /v1/generate` | `{data, intent, style?, output?}` | JSON: final `spec`, `option`, `warnings`, `artifact`, and `requestId` |
| `GET /v1/capabilities` | None | Types, themes, limits, and model configuration status |
| `GET /openapi.json` | None | OpenAPI 3.1 definition |
| `GET /health/live` | None | Process liveness |
| `GET /health/ready` | None | Renderer readiness and AI configuration status |

### Data and field mappings

Save this JSON as `request.json` and submit it to `/v1/charts`:

```json
{
  "spec": {
    "type": "bar",
    "title": "Monthly count",
    "data": [
      {"month": "January", "count": 12},
      {"month": "February", "count": 18}
    ],
    "encoding": {"x": "month", "y": ["count"]}
  },
  "style": {"theme": "report"},
  "output": {"format": "png", "width": 960, "height": 540, "pixelRatio": 2}
}
```

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/charts \
  -H 'Content-Type: application/json' \
  --data-binary @request.json --output chart.png
```

This produces a 1920 × 1080 PNG. The example assumes a local anonymous service. Add the Bearer header when authentication is enabled.

### Existing ECharts options

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/render \
  -H 'Content-Type: application/json' \
  --data-binary @examples/render.json --output chart.svg
```

The `option` input supports only the static types above and a restricted configuration subset. It is **not an execution environment for arbitrary ECharts options**. Functions, scripts, external images/URLs, maps, GL, custom rendering, and browser interactions are unsupported.

### Image style and size

- Themes: `light`, `dark`, and `report`; default: `light`.
- `style.palette`: 1–20 hexadecimal colors; `fontSize`: 10–32, default 14; `background`: a hexadecimal color or `transparent`.
- Default output: SVG at 960 × 540. Width: 240–2400; height: 180–2400.
- PNG `pixelRatio`: 1–3. Physical dimensions must be integers, with at most 16 million pixels. SVG only accepts `pixelRatio: 1`.
- PNG fixes the rendered appearance of Chinese text. SVG retains text and depends on the recipient's fonts. Dense charts or long labels may be truncated; adjust the canvas or reduce the data.

## Enable natural-language generation

Configure a model in your local `.env.local`. For example, with Alibaba Cloud DashScope:

```dotenv
ALLOW_ANONYMOUS=true
LLM_ENABLED=true
LLM_PROVIDER=dashscope
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen3.8-flash
LLM_API_KEY=replace-with-your-provider-key
```

Anonymous mode here is for local testing only. Keep your authentication settings if you already use a service key. Restart `npm run dev`, then run:

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/generate \
  -H 'Content-Type: application/json' \
  --data-binary @examples/generate.json --output generated.json
node --input-type=module -e "import fs from 'node:fs'; const r=JSON.parse(fs.readFileSync('generated.json','utf8')); fs.writeFileSync('generated.png',Buffer.from(r.artifact.base64,'base64'));"
```

The generation endpoint returns JSON, not raw PNG bytes. `artifact` contains `mimeType`, `width`, `height`, `bytes`, and either PNG `base64` or SVG `svg` text. The supplied example uses a Chinese intent; you can replace `intent` with your own description.

The model receives your intent, field types, row count, and bounded samples from the first five rows. **This content is sent to your configured model provider.** The full original data is bound locally and is not rewritten by the model. Each generation makes at most two model calls, with a default total timeout of 60 seconds and a concurrency limit of 2. Review the chart type and field choices before using the result.

Model requests explicitly send `response_format: {"type":"json_object"}` and `enable_thinking: false`, while retaining the schema in the prompt and full local validation. Native JSON Schema mode is not enabled. Invalid JSON, schema errors, truncated output, and invalid field mappings allow one corrective call within the same total deadline. Authentication, network, and upstream HTTP failures are not automatically retried.

`LLM_LOG_LEVEL` defaults to `info` and accepts `debug/info/warn/error/off`, case-insensitively. `info` includes model latency, available token usage, finish reason, and generation results; `warn` includes failures and correction decisions; `error` includes final failures. `debug` adds generation, model, plan validation, and rendering stages. Events share a `generationId`, with HTTP/MCP/A2A entry metadata. Every level records only allowed metadata: no intent, data samples, model content, raw exceptions, authentication headers, or keys. This setting controls generation diagnostics independently of HTTP access logs.

DashScope `qwen3.8-flash` has been tested. Other OpenAI-compatible services need separate validation. Deterministic rendering works without a model; set `LLM_ENABLED=false` to explicitly disable model calls.

## Connect an MCP client

Endpoint: `http://127.0.0.1:3000/mcp`, using **Streamable HTTP**. Enter this URL in a client that supports remote MCP, and attach the Bearer header when authentication is enabled. There is no stdio transport.

| Tool | Purpose |
| --- | --- |
| `get_chart_capabilities` | Discover types, formats, themes, limits, and model configuration status before first use |
| `render_chart` | Default for structured data; the calling agent creates a ChartSpec, with no server-side model required |
| `render_echarts` | Render an existing JSON option or fine-tune layout within the static option constraints |
| `generate_chart` | Delegate chart planning to the server-side model; available only with complete model configuration |

Tool arguments match the corresponding HTTP request bodies. PNG is returned as MCP `image` content and SVG as `text`. Metadata is in `structuredContent`; the generation tool also includes the final spec/option/warnings.

The service returns neither download URLs nor chart editing IDs. Clients save or display the image and submit a complete updated request for revisions. Install the [chart skill](skills/echarts-agent-chart/SKILL.md) for data preparation, chart selection, and iteration, or the [connect skill](skills/echarts-agent-connect/SKILL.md) for connection checks. Basic constraints are also included in tool and parameter descriptions, so skills are optional for API use. See the [consumer guide](docs/consumer-guide.en.md) for installation and client configuration.

Run the included client:

```bash
CHART_URL=http://127.0.0.1:3000 node examples/mcp-client.mjs
```

Set `SERVICE_API_KEY` in the client environment when authentication is enabled. The output is `chart-mcp.png`. Requests are stateless. Closing an active request connection cancels downstream work; separate cancellation notifications do not guarantee correlation across requests. Use A2A for task-ID-based queries and cancellation.

## Connect an A2A agent

A2A is disabled by default and requires a service key. Add these settings to the server environment and restart:

```dotenv
SERVICE_API_KEY=replace-with-a-random-service-key
A2A_ENABLED=true
A2A_PUBLIC_URL=http://127.0.0.1:3000
```

`A2A_PUBLIC_URL` must be the service origin reachable by callers, without a path, query, or credentials. Replace the loopback address for remote deployments.

- Agent Card: `/.well-known/agent-card.json`; Bearer authentication is required here too. Send `A2A-Version: 1.0` for the new Card; omitting the header or sending `0.3` preserves the legacy Card.
- JSON-RPC: `/a2a`; supports **A2A 1.0** (specification revision 1.0.1) with **0.3** compatibility. Send `A2A-Version: 1.0` for new requests.
- 1.0 methods: `SendMessage`, `GetTask`, and `CancelTask`. The 0.3 methods remain `message/send`, `tasks/get`, and `tasks/cancel`.
- Input: one structured data part containing `{operation:"render"|"chart"|"generate", request:corresponding HTTP body}`. A 1.0 JSON message uses `role:"ROLE_USER"` and `parts:[{data:input}]`.
- 1.0 images are returned as base64 in `result.task.artifacts[].parts[].raw`, with `mediaType` and `filename`; 0.3 retains `file.bytes`. Neither version provides download URLs.

```bash
CHART_URL=http://127.0.0.1:3000 node examples/a2a-client.mjs
```

The example uses the official `@a2a-js/sdk` 1.3.0 client, which sends the version header automatically. Set the same `SERVICE_API_KEY` in the client environment. The output is `chart-a2a.png`. The SDK converts JSON requests to its internal types using `SendMessageRequest.fromJSON`; `sendMessage` returns the Task directly, and image bytes are in `part.content.value` (`$case === "raw"`, a `Buffer`). These SDK types differ from the JSON wire representation above.

In 1.0, set `configuration.returnImmediately=true` to receive a task ID before completion and query it later; the default waits for completion. The 0.3 equivalent is `configuration.blocking=false`. Canceling an already canceled task returns its canceled state; completed or failed tasks cannot be canceled. Neither version stores message history; `historyLength` must be omitted or zero. Completed tasks are retained for at most 10 minutes, with limits of 100 tasks and 64 MiB in memory; capacity pressure may evict them sooner. Restarting loses all tasks. `ListTasks`, streaming, push notifications, continuation, and file inputs are unsupported. Callers sharing a key share access to tasks, and nonempty `tenant` values are rejected.

## Configuration reference

See [.env.example](.env.example) for the template. `npm run dev` loads `.env.local`; `npm start` uses the process environment and does not automatically load that file.

| Variable | Default / meaning |
| --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000`; explicitly use `HOST=127.0.0.1` for local runs |
| `SERVICE_API_KEY` | Unset; shared Bearer key for server and clients |
| `ALLOW_ANONYMOUS` | Off by default; only `true` enables it, required to start without a key |
| `RENDER_WORKERS` | `2`; range: 1–4 |
| `RENDER_QUEUE_LIMIT` | `8`; range: 0–32 |
| `RENDER_TIMEOUT_MS` | `10000`; range: 100–30000, including queue time |
| `LLM_ENABLED` | Disabled without a key; `false` forces it off |
| `LLM_PROVIDER` | `openai-compatible`; provider identifier |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | All required when using a model |
| `LLM_TIMEOUT_MS` | `60000`; range: 100–60000 |
| `LLM_LOG_LEVEL` | `info`; `debug/info/warn/error/off` for sanitized generation diagnostics |
| `A2A_ENABLED` / `A2A_PUBLIC_URL` | Disabled by default; enabling requires a service origin and service key |

Lowercase aliases are supported: `llm_provider`, `llm_base_url`, `llm_default_model`, and `llm_api_key`. The corresponding uppercase variables take precedence. AI status `ready` means configuration is complete, not that provider connectivity has been tested.

## Troubleshooting and limits

| Symptom | What to check |
| --- | --- |
| Startup fails | Configure a service key or local anonymous mode; check the port, numeric settings, and required A2A settings |
| `401 UNAUTHORIZED` | Send the correct Bearer key; MCP and the Agent Card need it too |
| `422 INVALID_INPUT` | Check field names, value types, and chart semantics; inspect error `details` |
| `503 AI_UNAVAILABLE` | Check model configuration and whether `LLM_ENABLED=false` disables it |
| `502 AI_FAILED` / `AI_INVALID_PLAN` | Check provider settings, or use ChartSpec to specify the type and fields explicitly |
| `429 QUEUE_FULL` / `AI_BUSY` | Reduce concurrency and retry later |
| `504 RENDER_TIMEOUT` / `AI_TIMEOUT` | Reduce data/chart complexity or check model latency |
| Chinese text differs in SVG but PNG looks correct | Install the corresponding font on the receiving system or use PNG |

Limits: 1 MiB request body, 20 series, 10,000 data points, and 10 MiB per image. MCP/A2A wrapped responses also have size limits; base64 adds overhead. Hierarchical charts allow at most 1000 nodes and 8 levels; Sankey charts allow 500 nodes and 2000 edges.

There is no image hosting, database, CSV/Excel upload parser, PDF output, map/GL support, custom scripting, or interactive HTML output. One service key represents a shared trust domain; there is no multi-tenant isolation.

## Development and verification

```bash
npm run typecheck
npm test
```

Automated tests cover input contracts, rendering, HTTP/MCP/A2A, and consumer clients. Historical live-model and dual-architecture container checks are recorded in the [completion log](docs/project/progress-log.md); each record states its verification scope. Optional live checks:

```bash
npm run smoke:live  # 4 HTTP/MCP/A2A generations; at most 2 model calls each
npm run build && node --env-file-if-exists=.env.local scripts/smoke-extended.mjs
node scripts/smoke-docker.mjs echarts-agent:local --a2a
node scripts/smoke-docker.mjs echarts-agent:local --a2a --live
```

Container checks with `--live` access the model; without it, the container runs without networking. Recorded results are sample measurements, not performance guarantees for all inputs.

More information (in Chinese): [API and data contract](docs/specs/2026-09-16-echarts-agent-design.md) · [Initial verification](docs/verification/2026-09-16.md) · [Additional chart verification](docs/verification/2026-09-16-extended.md) · [Examples](examples)

## License

The project uses the [MIT License](LICENSE). The bundled Noto Sans CJK SC font is covered separately by the [SIL Open Font License](assets/fonts/LICENSE); see the [font notes](assets/fonts/README.md) for its source.
