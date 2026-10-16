# Use ECharts Agent from Your Own Agent

[中文](consumer-guide.md) · [Back to README](../README.en.md)

After deploying the service, install the consumer skills and connect to the service. Your own Agent can then organize data, choose a chart, call the renderer, and deliver the image. The skills do not require the service source code or npm dependencies; deterministic rendering does not require a model configured on the service.

## Install the two skills

Download or copy the following **complete directories** from this repository, keeping their scripts, reference materials, and examples. If a skill with the same name already exists, compare its version and local changes before updating it.

| Directory | Purpose |
| --- | --- |
| [echarts-agent-connect](../skills/echarts-agent-connect/SKILL.md) | Connect to a deployed service, diagnose authentication and network issues, and verify available capabilities |
| [echarts-agent-chart](../skills/echarts-agent-chart/SKILL.md) | Turn data into SVG/PNG charts, save the result, and revise it based on feedback |

| Local host | Personal skill directory | Project skill directory |
| --- | --- | --- |
| Codex | `~/.agents/skills/` | `.agents/skills/` in the user's working project |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` in the user's working project |
| Other hosts that support Agent Skills | Use the host's skill installation entry point or specified directory | Follow the host documentation |

The installed layout should be `skill-directory/echarts-agent-chart/SKILL.md`; do not copy only `SKILL.md`. Refresh skills or restart the session as required by the host. The two skills can be installed independently; users who already have a connected service only need the chart skill. An Agent without skill support can still use MCP tools or treat the skill content as task reference, but it must have network request capabilities. References: [Codex Skills](https://learn.chatgpt.com/docs/build-skills), [Claude Code Skills](https://code.claude.com/docs/en/skills) (checked on 2026-10-16).

## Prepare the address and authentication

- Use a service address reachable from the **environment where the Agent actually runs**. For a remote container or cloud Agent, `127.0.0.1` points to that environment itself, not the user's computer.
- The MCP address is `https://charts.example.com/mcp`; scripts use the service origin `CHART_URL=https://charts.example.com`. Replace the example domain with your deployment.
- When authentication is required, provide `SERVICE_API_KEY` through the host's credential store or startup environment, with the same value as the server. Do not put the real value in skills, shared configuration, command arguments, or conversations; do not print the environment variable while troubleshooting.
- HTTP, MCP, and A2A share the server's authentication policy. A configured `SERVICE_API_KEY` requires Bearer for all three, even with `ALLOW_ANONYMOUS=true`. Without a key, explicit `ALLOW_ANONYMOUS=true` allows anonymous access; otherwise the server rejects startup. Health checks never require authentication. OpenAPI and both Agent Card versions declare the current security requirements.
- Desktop hosts do not always inherit the terminal environment. Confirm that the variable exists in the process environment that starts the Agent; setting it in another terminal is usually ineffective. Omit authentication only when the deployer has explicitly enabled anonymous access.

Skills provide workflows; they do not automatically install MCP/A2A protocol support. Prefer native MCP when the host supports it, and use A2A when an A2A orchestrator is already available. Use the script below only when the host has terminal/HTTP tools or when reliably saving images is necessary.

## Codex: remote MCP

Register the service in an environment where `SERVICE_API_KEY` has already been injected (pass only the variable name):

```bash
codex mcp add echarts-agent --url https://charts.example.com/mcp --bearer-token-env-var SERVICE_API_KEY
codex mcp list
```

You can also merge the following section into the existing `~/.codex/config.toml`; do not overwrite other configuration. These two methods are alternatives. This example adds a 90-second tool timeout to cover optional generation operations.

```toml
[mcp_servers.echarts-agent]
url = "https://charts.example.com/mcp"
bearer_token_env_var = "SERVICE_API_KEY"
tool_timeout_sec = 90
```

For an anonymous service, omit the Bearer configuration. A fixed service key does not use the OAuth login flow. After reloading the connection, you can say:

> Use $echarts-agent-connect to check the configured chart service and generate a sample PNG with synthetic data.

> Use $echarts-agent-chart to aggregate this CSV by month, generate a bar chart for a report, and save it as monthly.png.

Configuration fields: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). The CLI parameters were also checked locally with `codex mcp add --help`. Host tool names may include a service prefix; the skill uses the tools that are actually discovered.

## Claude Code: remote MCP

Merge the following configuration into `.mcp.json` in the user's working project, keeping other servers. `${SERVICE_API_KEY}` is a reference that Claude Code expands from the startup environment; do not replace it with a plaintext secret.

```json
{
  "mcpServers": {
    "echarts-agent": {
      "type": "http",
      "url": "https://charts.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${SERVICE_API_KEY}"
      }
    }
  }
}
```

For an anonymous service, remove `headers`. Reload the connection and use `/mcp` to check its status; follow the client's own project configuration confirmation flow. You can explicitly invoke `/echarts-agent-connect` or `/echarts-agent-chart`, or state the request in natural language. Configuration and environment expansion: [Claude Code MCP](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson). Configuration files from other desktop products are not necessarily compatible with this format.

## Generic MCP clients

Choose **Streamable HTTP**, then enter the `/mcp` address and Bearer credential. The service does not provide stdio or a separate legacy SSE address. After connecting, list the tools and call `get_chart_capabilities` first:

| Input/goal | Choice |
| --- | --- |
| Data and a charting request | Have the current Agent generate a ChartSpec and call `render_chart`; no server-side model is needed |
| An existing ECharts JSON option or fine-grained layout | Use `render_echarts`, subject to the static option restrictions |
| Delegate chart planning to the server-side model | Call `generate_chart` only when the tool is available |

`ai.status=ready` means the configuration is complete; it does not prove that the provider is reachable. `generate_chart` sends the intent, field information, row count, and bounded samples from the first five rows to the configured model provider; the other two rendering methods do not call the server-side model.

PNG is returned in MCP `image` content, SVG in `text`, and `structuredContent` provides metadata. The service has no download URL and does not write directly to the user's computer. Some clients can display images but cannot save the raw bytes from tool results; in that case, resubmit the same request with the HTTP script and save the result, reporting the actual path. Do not treat `requestId` as a chart ID; submit the complete request again to make a revision.

## Terminal only: standalone HTTP script

Node.js 22 or later is required; no `npm install` is needed. Run the following from the downloaded repository root. After installing the skills, replace the script paths with the actual skill directories. The scripts read credentials only from the environment; they do not read the project's `.env.local`.

```bash
export CHART_URL=https://charts.example.com
node skills/echarts-agent-connect/scripts/check-service.mjs
node skills/echarts-agent-chart/scripts/chart-client.mjs capabilities
node skills/echarts-agent-chart/scripts/chart-client.mjs chart skills/echarts-agent-chart/assets/report-bar.json report.png
```

`SERVICE_API_KEY` should be injected in advance by a secure startup environment. `check-service` checks render readiness and an authenticated capabilities query; after the capability check succeeds, actually generating an image is still required to complete the charting verification. The example uses synthetic data.

The client supports `chart request.json output.png`, `render request.json output.svg`, and `generate request.json output.png`; the request bodies correspond to `/v1/charts`, `/v1/render`, and `/v1/generate`, respectively. The output suffix must match the request format. The generation endpoint returns JSON; the client extracts the image before saving it. The program refuses to overwrite an existing file; choose another output path to keep the previous version.

The script's `generate` command saves only the image, without exporting the final plan or warnings. To review generated field mappings, retain the complete plan, and revise it precisely, retrieve those fields through native MCP/HTTP, or have the current Agent create a reusable ChartSpec and run `chart`.

The script requires `CHART_URL` to be an origin and rejects credentials, query parameters, or a path prefix. HTTP redirects are also rejected. The default timeout is 15 seconds for the full check and 90 seconds for the chart client; set `CHART_TIMEOUT_MS` to a value from 100 to 120000 milliseconds. Timeouts and failures are not retried automatically, and error responses are not saved as images. Input files are limited to 1 MiB, and response reads have a size limit.

## Existing A2A orchestrator

Ask the deployer to set `A2A_ENABLED=true` and configure the correct `A2A_PUBLIC_URL` first. This switch is independent of authentication, and the consumer skills do not change the service deployment. With a service key, card discovery and calls both require Bearer; explicit anonymous mode allows both without it:

1. `GET /.well-known/agent-card.json` with `A2A-Version: 1.0` and check the supported interfaces and operations.
2. Send `SendMessage` to `/a2a`, again with the version header. The message must contain exactly one structured `data` part whose content is `{operation:"chart"|"render"|"generate", request:corresponding HTTP request body}`; do not send only natural language or upload a CSV.
3. For asynchronous work, set `configuration.returnImmediately=true`, save the returned task ID, and use `GetTask` to query it. Call `CancelTask` only when the user cancels. Stop polling at a terminal state and enforce an overall deadline; do not resubmit a task because a query failed.
4. On success, decode the image from `result.task.artifacts[].parts[].raw`; for `GetTask`, the task is directly under `result`. Check `mediaType` and save the bytes; do not treat base64 as a download URL.

See the chart skill's [A2A reference](../skills/echarts-agent-chart/references/a2a.md) for the complete message example, the 0.3 compatibility path, and status handling. Projects that already use an SDK can refer to the [official JS SDK client example](../examples/a2a-client.mjs); that example requires the repository dependencies and differs from the dependency-free HTTP script.

A2A is disabled by default. Tasks are kept in memory, retained for at most 10 minutes after reaching a terminal state, and may be evicted earlier; a restart loses them. There is no task continuation, file input, streaming, or push notification. With authentication enabled, callers using the same key share the same task scope. In anonymous mode, all callers that can reach the instance share that scope and can read or cancel a task if they know its ID. The `skills` declared in the Agent Card describe service capabilities; the `SKILL.md` installed on the local machine provides operating guidance.

## Verification and troubleshooting

Use synthetic data to complete a capability query, save a PNG, and redraw it with “make it horizontal and add units,” then connect the workflow to real business data. The result should open, its values should match the input, and the Agent should identify the file path. If the host has visual capabilities, also check labels, legends, and truncation.

| Symptom | Next step |
| --- | --- |
| Connection failure or 404 | Check whether the execution environment can reach the address, the MCP path, and the proxy; A2A also requires confirmation that the deployer enabled it |
| 401 | Check the credentials in the host process and the target service; do not print the key or resubmit the same request repeatedly |
| No `generate_chart` / AI unavailable | Have the current Agent generate a ChartSpec and use deterministic rendering; a server-side model is not required for charting |
| 422 / MCP `isError` | Inspect the actual error, field types, and chart semantics; the model schema does not cover every runtime restriction |
| 413 / output too large | Reduce the image size; MCP/A2A base64 wrapping also adds size, so use HTTP for binary retrieval when necessary |
| 429 / timeout | Reduce concurrency or complexity; before a bounded retry, determine the cause, and for A2A query the existing task to avoid duplicate submissions |
| Image is displayed but no file is available | Check whether the host can retrieve the raw tool content; use HTTP saving when necessary, and do not invent a download URL |

The service accepts only prepared JSON data; it does not parse CSV/Excel, aggregate, fill missing points, or provide long-term storage. See [Supported charts](../README.en.md#supported-charts) in the README for chart coverage, dimensions, and data semantics. The skill installation and client configuration instructions were checked against the official documentation; permissions, credential injection, and image display still need to be verified in the consumer's actual desktop host.
