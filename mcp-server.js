// Read-only MCP (Model Context Protocol) server for the QTR Kitchen Hub,
// mounted at /mcp on the main Express app so Joel can connect it to Claude
// as a custom connector. Stateless Streamable HTTP transport (no session
// tracking needed — every tool call here is a one-shot read), protected by
// a single long bearer token kept in the MCP_ACCESS_TOKEN env var. This
// file only ever reads from the database; it has no write/mutate tools.
const express = require("express");
const crypto = require("crypto");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const db = require("./db");

function requireMcpAuth(req, res, next) {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) {
    return res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "MCP server not configured (missing MCP_ACCESS_TOKEN)" },
      id: null,
    });
  }

  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(req.headers["authorization"] || "");
  const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!valid) {
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  next();
}

function searchSupplierProducts(query) {
  return db
    .prepare(
      `SELECT i.name, i.unit, i.price, u.name AS shop_name, c.name AS category
       FROM items i
       LEFT JOIN users u ON u.id = i.shop_id
       LEFT JOIN categories c ON c.id = i.category_id
       WHERE i.active = 1 AND i.name LIKE ?
       ORDER BY i.name
       LIMIT 50`
    )
    .all(`%${query}%`);
}

function formatProductRow(r) {
  const price = r.price !== null && r.price !== undefined ? `$${r.price.toFixed(2)}` : "no price set";
  const scope = r.shop_name ? r.shop_name : "all shops";
  return `${r.name} — ${price} per ${r.unit} (${r.category || "uncategorized"}; ${scope})`;
}

function getServer() {
  const server = new McpServer({ name: "qtr-kitchen-hub", version: "1.0.0" }, { capabilities: {} });

  server.registerTool(
    "search_supplier_products",
    {
      description:
        "Search QTR's internal product/ordering catalog by name — what each shop orders from the central kitchen, with unit and price. Read-only.",
      inputSchema: {
        query: z.string().describe("Text to search for in product names, e.g. 'cups' or 'almond milk'"),
      },
    },
    async ({ query }) => {
      const rows = searchSupplierProducts(query);
      const text =
        rows.length === 0
          ? `No supplier products found matching "${query}".`
          : rows.map(formatProductRow).join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "get_recipes",
    {
      description:
        "Look up a QTR recipe or build by name. Not loaded yet — this always returns a placeholder until recipe content is added.",
      inputSchema: {
        query: z.string().describe("Recipe or item name to look up").optional(),
      },
    },
    async () => ({
      content: [{ type: "text", text: "No recipes have been loaded into this server yet. Ask Joel to add them." }],
    })
  );

  server.registerTool(
    "get_branding_info",
    {
      description:
        "Look up QTR's brand voice, positioning, or visual identity info. Not loaded yet — this always returns a placeholder until branding content is added.",
      inputSchema: {
        topic: z.string().describe("Branding topic to look up, e.g. 'voice' or 'colors'").optional(),
      },
    },
    async () => ({
      content: [
        { type: "text", text: "No branding info has been loaded into this server yet. Ask Joel to add it." },
      ],
    })
  );

  server.registerTool(
    "search_hub",
    {
      description:
        "General search across the QTR Kitchen Hub's available read-only data. Currently covers supplier products/prices only — recipes and branding info aren't loaded yet.",
      inputSchema: {
        query: z.string().describe("Free-text search term"),
      },
    },
    async ({ query }) => {
      const rows = searchSupplierProducts(query);
      const lines = [];
      if (rows.length > 0) {
        lines.push(`Supplier products matching "${query}":`, ...rows.map((r) => `  - ${formatProductRow(r)}`));
      } else {
        lines.push(`No supplier products matched "${query}".`);
      }
      lines.push("", "(Recipes and branding info are not loaded into this hub yet.)");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  return server;
}

function createMcpRouter() {
  const router = express.Router();
  router.use(express.json());
  router.use(requireMcpAuth);

  router.post("/", async (req, res) => {
    const server = getServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  router.get("/", (req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  router.delete("/", (req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  return router;
}

module.exports = { createMcpRouter };
