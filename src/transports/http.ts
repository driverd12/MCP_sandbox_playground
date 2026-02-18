import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logEvent } from "../utils.js";

export type HttpOptions = {
  port: number;
  host: string;
  allowedOrigins: string[];
  bearerToken: string | null;
};

export async function startHttpTransport(server: Server, options: HttpOptions) {
  if (options.host !== "127.0.0.1" && options.host !== "localhost") {
    throw new Error("HTTP transport must bind to 127.0.0.1 or localhost");
  }
  if (!options.bearerToken) {
    throw new Error("MCP_HTTP_BEARER_TOKEN is required for HTTP transport");
  }

  const transport = new StreamableHTTPServerTransport();

  const httpServer = http.createServer((req, res) => {
    if (!validateOrigin(req.headers.origin, options.allowedOrigins)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    if (!validateBearer(req.headers.authorization, options.bearerToken)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    void transport.handleRequest(req, res).catch((error) => {
      logEvent("http.error", { error: String(error) });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
  });

  await server.connect(transport);

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, options.host, () => resolve());
  });

  logEvent("http.listen", { host: options.host, port: options.port });
}

function validateOrigin(origin: string | undefined, allowed: string[]) {
  if (!origin) {
    return false;
  }
  return allowed.includes(origin);
}

function validateBearer(authorization: string | undefined, expected: string | null) {
  if (!expected) {
    return false;
  }
  if (!authorization) {
    return false;
  }
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" && token === expected;
}
