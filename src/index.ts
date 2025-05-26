import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";
import { z } from "zod";

// Initialize Notion client
const notion = new Client({
   auth: process.env.NOTION_API_KEY,
});

// Validation schemas
const schemas = {
   notionTitle: z.object({
      type: z.literal("title"),
      title: z.array(
         z.object({
            plain_text: z.string(),
         }),
      ),
   }),

   notionPage: z.object({
      id: z.string(),
      url: z.string(),
      properties: z.record(
         z.union([
            z.object({
               type: z.literal("title"),
               title: z.array(
                  z.object({
                     plain_text: z.string(),
                  }),
               ),
            }),
            z.any(),
         ]),
      ),
   }),

   toolInputs: {
      searchPages: z.object({
         query: z.string(),
      }),
      readPage: z.object({
         pageId: z.string(),
      }),
      retrieveDatabase: z.object({
         databaseId: z.string(),
      }),
   },

   databaseProperties: z.record(z.union([
      z.object({ title: z.object({}) }),
      z.object({ rich_text: z.object({}) }),
      z.object({ number: z.object({ format: z.string().optional() }) }),
      z.object({
         select: z.object({
            options: z.array(
               z.object({
                  name: z.string(),
                  color: z.string().optional()
               })
            ).optional()
         })
      }),
      z.object({
         multi_select: z.object({
            options: z.array(
               z.object({
                  name: z.string(),
                  color: z.string().optional()
               })
            ).optional()
         })
      }),
      z.object({ date: z.object({}) }),
      z.object({ checkbox: z.object({}) })
   ])),
};

// Add this after your schemas
function formatError(error: any): string {
   console.error('Full error:', JSON.stringify(error, null, 2));

   if (error.status === 404) {
      return `Resource not found. Please check the provided ID. Details: ${error.body?.message || error.message}`;
   }
   if (error.status === 401) {
      return `Authentication error. Please check your API token. Details: ${error.body?.message || error.message}`;
   }
   if (error.status === 400) {
      return `Bad request. Details: ${error.body?.message || error.message}`;
   }
   if (error.code) {
      return `API Error (${error.code}): ${error.body?.message || error.message}`;
   }
   return error.body?.message || error.message || "An unknown error occurred";
}

// Tool definitions
const TOOL_DEFINITIONS = [
   {
      name: "search_pages",
      description: "Search through Notion pages",
      inputSchema: {
         type: "object",
         properties: {
            query: {
               type: "string",
               description: "Search query",
            },
         },
         required: ["query"],
      },
   },
   {
      name: "read_page",
      description: "Read a regular page's content (not for databases - use retrieve_database for databases). Shows block IDs with their types (needed for block operations)",
      inputSchema: {
         type: "object",
         properties: {
            pageId: {
               type: "string",
               description: "ID of the page to read",
            },
         },
         required: ["pageId"],
      },
   },
   {
      name: "query_database",
      description: "Query a database",
      inputSchema: {
         type: "object",
         properties: {
            databaseId: {
               type: "string",
               description: "ID of the database",
            },
            filter: {
               type: "object",
               description: "Filter conditions",
            },
            sort: {
               type: "object",
               description: "Sort conditions",
            },
         },
         required: ["databaseId"],
      },
   },
   {
      name: "retrieve_database",
      description: "Retrieve a database's metadata",
      inputSchema: {
         type: "object",
         properties: {
            databaseId: {
               type: "string",
               description: "ID of the database to retrieve",
            },
         },
         required: ["databaseId"],
      },
   },
];

// Tool implementation handlers
const toolHandlers = {
   async search_pages(args: unknown) {
      const { query } = schemas.toolInputs.searchPages.parse(args);
      console.error(`Searching for: ${query}`);

      const response = await notion.search({
         query,
         filter: { property: "object", value: "page" },
         page_size: 99,
      });

      if (!response.results || response.results.length === 0) {
         return {
            content: [
               {
                  type: "text" as const,
                  text: `No pages found matching "${query}"`,
               },
            ],
         };
      }

      const formattedResults = response.results
         .map((page: any) => {
            let title = "Untitled";
            try {
               // Extract title from URL
               const urlMatch = page.url.match(/\/([^/]+)-[^/]+$/);
               if (urlMatch) {
                  title = decodeURIComponent(urlMatch[1].replace(/-/g, ' '));
               }
               // If no title from URL or it's still "Untitled", try properties
               if (title === "Untitled" && page.properties) {
                  const titleProperty = page.properties.title || page.properties.Name;
                  if (titleProperty?.title?.[0]?.plain_text) {
                     title = titleProperty.title[0].plain_text;
                  }
               }
            } catch (e) {
               console.error("Error extracting title:", e);
            }

            return `• ${title}\n  Link: ${page.url}`;
         })
         .join("\n\n");

      return {
         content: [
            {
               type: "text" as const,
               text: `Found ${response.results.length} pages matching "${query}":\n\n${formattedResults}`,
            },
         ],
      };
   },

   async read_page(args: unknown) {
      const { pageId } = schemas.toolInputs.readPage.parse(args);

      try {
         const [blocksResponse, pageResponse] = await Promise.all([
            notion.blocks.children.list({ block_id: pageId }),
            notion.pages.retrieve({ page_id: pageId }),
         ]);

         const page = schemas.notionPage.parse(pageResponse);

         // Get title
         const titleProp = Object.values(page.properties).find((prop) => prop.type === "title");
         const title = titleProp?.type === "title" ? titleProp.title[0]?.plain_text || "Untitled" : "Untitled";

         // Process blocks and collect child pages/databases
         const childPages: string[] = [];
         const childDatabases: string[] = [];
         const contentBlocks: string[] = [];

         for (const block of blocksResponse.results as Array<{ type: string; id: string;[key: string]: any }>) {
            const type = block.type;

            if (type === "child_page") {
               childPages.push(`📄 ${block.child_page.title || "Untitled Page"} (ID: ${block.id.replace(/-/g, "")})`);
               continue;
            }

            if (type === "child_database") {
               childDatabases.push(`📊 ${block.child_database.title || "Untitled Database"} (ID: ${block.id.replace(/-/g, "")})`);
               continue;
            }

            const textContent = block[type]?.rich_text?.map((text: any) => text.plain_text).join("") || "";
            let formattedContent = "";

            switch (type) {
               case "paragraph":
               case "heading_1":
               case "heading_2":
               case "heading_3":
                  formattedContent = textContent;
                  break;
               case "bulleted_list_item":
               case "numbered_list_item":
                  formattedContent = "• " + textContent;
                  break;
               case "to_do":
                  const checked = block.to_do?.checked ? "[x]" : "[ ]";
                  formattedContent = checked + " " + textContent;
                  break;
               case "code":
                  formattedContent = "```\n" + textContent + "\n```";
                  break;
               default:
                  formattedContent = textContent;
            }

            if (formattedContent) {
               contentBlocks.push(formattedContent);
            }
         }

         // Combine all content
         let output = `# ${title}\n\n`;

         if (contentBlocks.length > 0) {
            output += contentBlocks.join("\n") + "\n\n";
         }

         if (childPages.length > 0) {
            output += "## Child Pages\n" + childPages.join("\n") + "\n\n";
         }

         if (childDatabases.length > 0) {
            output += "## Child Databases\n" + childDatabases.join("\n") + "\n";
         }

         return {
            content: [
               {
                  type: "text" as const,
                  text: output.trim(),
               },
            ],
         };
      } catch (error) {
         console.error("Error reading page:", error);
         return {
            content: [
               {
                  type: "text" as const,
                  text: formatError(error),
               },
            ],
         };
      }
   },
   async query_database(args: unknown) {
      const { databaseId, filter, sort } = args as any;

      try {
         const response = await notion.databases.query({
            database_id: databaseId,
            filter,
            sorts: sort ? [sort] : undefined,
         });

         return {
            content: [
               {
                  type: "text" as const,
                  text: JSON.stringify(response.results, null, 2),
               },
            ],
         };
      } catch (error) {
         console.error("Error querying database:", error);
         return {
            content: [
               {
                  type: "text" as const,
                  text: `Error querying database: ${formatError(error)}`,
               },
            ],
         };
      }
   },
   async retrieve_database(args: unknown) {
      const { databaseId } = args as any;

      try {
         const response = await notion.databases.retrieve({
            database_id: databaseId,
         });

         return {
            content: [
               {
                  type: "text" as const,
                  text: JSON.stringify(response, null, 2),
               },
            ],
         };
      } catch (error) {
         console.error("Error retrieving database:", error);
         return {
            content: [
               {
                  type: "text" as const,
                  text: formatError(error),
               },
            ],
         };
      }
   },
};

// Initialize MCP server
const server = new Server(
   {
      name: "notion-server",
      version: "1.0.0",
   },
   {
      capabilities: {
         tools: {},
      },
   },
);

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
   console.error("Tools requested by client");
   return { tools: TOOL_DEFINITIONS };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
   const { name, arguments: args } = request.params;

   try {
      const handler = toolHandlers[name as keyof typeof toolHandlers];
      if (!handler) {
         throw new Error(`Unknown tool: ${name}`);
      }

      return await handler(args);
   } catch (error) {
      console.error(`Error executing tool ${name}:`, error);
      throw error;
   }
});

// Start the server
async function main() {
   if (!process.env.NOTION_API_KEY) {
      throw new Error("NOTION_API_KEY environment variable is required");
   }

   const transport = new StdioServerTransport();
   await server.connect(transport);
   console.error("Notion MCP Server running on stdio");
}

main().catch((error) => {
   console.error("Fatal error:", error);
   process.exit(1);
});
