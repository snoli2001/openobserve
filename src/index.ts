import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenObserveClient } from "./openobserve.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function toolText(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function toolJson(value: unknown): ToolResult {
  return toolText(JSON.stringify(value, null, 2));
}

async function runTool(action: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return toolJson(await action());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return toolText(message, true);
  }
}

function createServer(client: OpenObserveClient): McpServer {
  const server = new McpServer({
    name: "openobserve-logs",
    version: "1.0.0",
  });

  server.tool(
    "list_streams",
    "List OpenObserve log streams. Returns name, stream_type, and stats (doc_num, doc_time_min, doc_time_max).",
    {},
    async () => runTool(() => client.listStreams()),
  );

  server.tool(
    "get_stream_schema",
    "Return the field names and types for one OpenObserve log stream.",
    {
      stream: z.string().describe("Log stream name"),
    },
    async ({ stream }) => runTool(() => client.getStreamSchema(stream)),
  );

  server.tool(
    "search_logs",
    "Search one OpenObserve log stream. minutes defaults to 60 and has no maximum. Set all_history to true to search from the stream's earliest log through now. size defaults to 50 and max is 200. When sql is omitted, selects rows from the given stream ordered by _timestamp descending.",
    {
      stream: z
        .string()
        .describe("Log stream name. Rejected when empty or when it contains spaces, quotes, or semicolons."),
      sql: z
        .string()
        .optional()
        .describe("SQL query. When omitted, the server selects from this stream."),
      minutes: z
        .number()
        .optional()
        .describe(
          "Lookback window in minutes. Default 60. No maximum. Ignored when all_history is true.",
        ),
      all_history: z
        .boolean()
        .optional()
        .describe(
          "When true, search from the stream's earliest log through now. Still returns at most size hits.",
        ),
      size: z.number().optional().describe("Maximum hits to return. Default 50. Maximum 200."),
    },
    async ({ stream, sql, minutes, all_history, size }) =>
      runTool(() => client.searchLogs({ stream, sql, minutes, all_history, size })),
  );

  return server;
}

async function main(): Promise<void> {
  const client = OpenObserveClient.fromEnv();
  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Fatal error";
  console.error(message);
  process.exit(1);
});
