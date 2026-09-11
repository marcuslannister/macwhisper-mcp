/**
 * MacWhisper transcription as an MCP tool over streamable HTTP.
 *
 * MacWhisper's `mw` CLI is a macOS binary that talks to the running app over a
 * local socket, so a Linux container can neither execute it nor reach it. This
 * process runs on the Mac, exposes one tool, and listens on loopback; NanoClaw
 * agent containers reach it at http://host.docker.internal:<port>/mcp.
 *
 * The tool takes a FILE NAME, never a path: it transcribes only what sits
 * directly in the shared transcribe directory. That keeps the bridge a
 * transcription service rather than a container-to-host arbitrary-file reader.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const TRANSCRIBE_DIR =
  process.env.MACWHISPER_MCP_DIR ?? path.join(homedir(), "nanoclaw-transcribe");
// Where MacWhisper's own installer puts the CLI (Settings → Advanced).
const MW_BINARY = "/usr/local/bin/mw";
// 10255 is taken by Docker on this host; 10254 is OneCLI's web UI.
const PORT = Number(process.env.MACWHISPER_MCP_PORT ?? 10256);
// A long recording transcribes for many minutes; mw also cold-starts the app
// (~13s) on the first call after launch.
const TRANSCRIBE_TIMEOUT_MIN = 45;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Shared token. Loopback is not an access boundary — every local process can
 * reach this port, whereas NanoClaw's own local service gates its socket at
 * 0600 (src/cli/socket-server.ts). install.sh writes .token 0600 and the same
 * value goes into the group's MCP headers.
 */
const TOKEN_FILE = path.join(import.meta.dirname, ".token");
const TOKEN = (
  process.env.MACWHISPER_MCP_TOKEN ??
  (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8") : "")
).trim();

function authorized(header: string | undefined): boolean {
  if (!TOKEN) return true; // No token configured — refuse to pretend otherwise.
  const presented = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(TOKEN);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

/**
 * One server + transport per request. This is the SDK's stateless recipe: a
 * shared instance carries per-connection initialization state, so the second
 * request on a shared transport fails.
 */
function makeServer(): McpServer {
  const server = new McpServer({ name: "macwhisper", version: "1.0.0" });
  server.registerTool(
    "transcribe",
    {
      title: "Transcribe audio or video with MacWhisper",
      description:
        "Transcribe a media file that sits in the shared transcribe directory, using MacWhisper on the host Mac. " +
        'Runs locally on the GPU — nothing is uploaded. Pass the file name only (e.g. "episode.mp3"), not a path. ' +
        "Returns the transcript as plain text. A long recording takes several minutes.",
      inputSchema: {
        file: z
          .string()
          .describe(
            'File name inside the shared transcribe directory, e.g. "episode.mp3".',
          ),
        language: z
          .string()
          .optional()
          .describe(
            'ISO 639-1 source language (e.g. "en", "zh") or "auto". Defaults to MacWhisper\'s setting.',
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Model in engine:model-id form. Defaults to the model selected in MacWhisper.",
          ),
      },
    },
    async ({ file, language, model }) => {
      if (file !== path.basename(file)) {
        return fail(
          `"${file}" must be a plain file name inside the transcribe directory, with no path separators.`,
        );
      }
      const target = path.join(TRANSCRIBE_DIR, file);
      if (!existsSync(target)) {
        return fail(
          `No such file: ${file}. Put the media file in the shared transcribe directory first.`,
        );
      }
      // The basename check alone still lets a symlink planted in the directory
      // point anywhere on the host. Resolve before handing the path to mw.
      const real = realpathSync(target);
      if (path.dirname(real) !== realpathSync(TRANSCRIBE_DIR)) {
        return fail(`${file} resolves outside the transcribe directory.`);
      }

      const args = ["transcribe", target, "--format", "txt"];
      if (language) args.push("--language", language);
      if (model) args.push("--model", model);

      try {
        const { stdout } = await execFileAsync(MW_BINARY, args, {
          timeout: TRANSCRIBE_TIMEOUT_MIN * 60_000,
          maxBuffer: MAX_OUTPUT_BYTES,
        });
        const transcript = stdout.trim();
        if (!transcript)
          return fail(`MacWhisper returned an empty transcript for ${file}.`);
        return { content: [{ type: "text" as const, text: transcript }] };
      } catch (err) {
        // A timeout kills mw with SIGTERM and leaves stderr empty, so say what
        // actually happened rather than falling through to a bare signal name.
        if ((err as { killed?: boolean }).killed) {
          return fail(
            `MacWhisper did not finish ${file} within ${TRANSCRIBE_TIMEOUT_MIN} minutes and was stopped. ` +
              `Check that MacWhisper is running on the Mac and that the file is not corrupt.`,
          );
        }
        // mw reports a missing app, an unsupported language, and a decode failure
        // all on stderr — pass it through so the agent can say what went wrong.
        const detail =
          (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
        return fail(`MacWhisper failed on ${file}: ${detail}`);
      }
    },
  );
  return server;
}

function fail(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

createServer(async (req, res) => {
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401).end();
    return;
  }
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("request failed", err);
    if (!res.headersSent) res.writeHead(500).end();
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(
    `macwhisper-mcp listening on http://127.0.0.1:${PORT}/mcp — serving ${TRANSCRIBE_DIR}`,
  );
});
