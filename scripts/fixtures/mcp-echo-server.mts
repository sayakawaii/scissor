/**
 * A tiny stdio MCP server used by scripts/test-mcp.mts. Exposes two tools:
 *  - echo: returns the input text as text content
 *  - shot: returns a 1x1 PNG as image content (to exercise image-to-file)
 * Uses the low-level Server API so it stays stable across SDK changes.
 *
 * Run (indirectly, via the MCP client): node --import tsx scripts/fixtures/mcp-echo-server.mts
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// 1x1 transparent PNG.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

const server = new Server(
  { name: "echo-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the given text back.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "shot",
      description: "Return a tiny screenshot as an image.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "echo") {
    return { content: [{ type: "text", text: `echo: ${String(args?.text ?? "")}` }] };
  }
  if (name === "shot") {
    return { content: [{ type: "image", data: PNG_1x1, mimeType: "image/png" }] };
  }
  return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
