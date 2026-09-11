/**
 * MacWhisper transcription as an MCP tool over streamable HTTP.
 *
 * MacWhisper's `mw` CLI is a macOS binary that talks to the running app over a
 * local socket, so a Linux container can neither execute it nor reach it. This
 * process runs on the Mac, exposes two tools, and listens on loopback;
 * NanoClaw agent containers reach it at http://host.docker.internal:<port>/mcp.
 *
 * Split into transcribe_start / transcribe_status rather than one blocking
 * call: a long recording outlasts a caller's round-trip patience, and a
 * blocking call gives the caller no chance to tell anyone it's still working.
 * Polling status lets the caller post progress pings between checks.
 *
 * Both tools take a FILE NAME, never a path: they operate only on what sits
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

interface Job {
  startedAt: number;
  finishedAt?: number;
  status: "running" | "done" | "error";
  result?: string;
  error?: string;
}

/**
 * One entry per (file, language, model) tuple, alive for the life of the
 * process. `transcribe_start` is idempotent while a job is running — a retry
 * lands here as a second call for the same key and gets the same job instead
 * of spawning a second `mw` child that fights the first over the GPU.
 */
const jobs = new Map<string, Job>();

function jobKey(file: string, language?: string, model?: string): string {
  return `${file}\0${language ?? ""}\0${model ?? ""}`;
}

/** Shared validation: plain basename, must exist, and — because the basename
 * check alone still lets a symlink planted in the directory point outside it
 * — must resolve to a real path still inside the transcribe directory. */
function resolveTarget(file: string): { target: string } | { fail: string } {
  if (file !== path.basename(file)) {
    return {
      fail: `"${file}" must be a plain file name inside the transcribe directory, with no path separators.`,
    };
  }
  const target = path.join(TRANSCRIBE_DIR, file);
  if (!existsSync(target)) {
    return {
      fail: `No such file: ${file}. Put the media file in the shared transcribe directory first.`,
    };
  }
  const real = realpathSync(target);
  if (path.dirname(real) !== realpathSync(TRANSCRIBE_DIR)) {
    return { fail: `${file} resolves outside the transcribe directory.` };
  }
  return { target };
}

function runJob(file: string, target: string, language?: string, model?: string): Job {
  const args = ["transcribe", target, "--format", "txt"];
  if (language) args.push("--language", language);
  if (model) args.push("--model", model);

  const job: Job = { startedAt: Date.now(), status: "running" };
  jobs.set(jobKey(file, language, model), job);

  execFileAsync(MW_BINARY, args, {
    timeout: TRANSCRIBE_TIMEOUT_MIN * 60_000,
    maxBuffer: MAX_OUTPUT_BYTES,
  })
    .then(({ stdout }) => {
      const transcript = stdout.trim();
      job.finishedAt = Date.now();
      if (transcript) {
        job.status = "done";
        job.result = transcript;
      } else {
        job.status = "error";
        job.error = `MacWhisper returned an empty transcript for ${file}.`;
      }
    })
    .catch((err) => {
      job.finishedAt = Date.now();
      job.status = "error";
      // A timeout kills mw with SIGTERM and leaves stderr empty, so say what
      // actually happened rather than falling through to a bare signal name.
      if ((err as { killed?: boolean }).killed) {
        job.error =
          `MacWhisper did not finish ${file} within ${TRANSCRIBE_TIMEOUT_MIN} minutes and was stopped. ` +
          `Check that MacWhisper is running on the Mac and that the file is not corrupt.`;
      } else {
        // mw reports a missing app, an unsupported language, and a decode
        // failure all on stderr — pass it through so the caller can say what
        // went wrong.
        job.error = `MacWhisper failed on ${file}: ${(err as { stderr?: string }).stderr?.trim() || (err as Error).message}`;
      }
    });

  return job;
}

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

const fileArgs = {
  file: z
    .string()
    .describe('File name inside the shared transcribe directory, e.g. "episode.mp3".'),
  language: z
    .string()
    .optional()
    .describe(
      'ISO 639-1 source language (e.g. "en", "zh") or "auto". Defaults to MacWhisper\'s setting.',
    ),
  model: z
    .string()
    .optional()
    .describe("Model in engine:model-id form. Defaults to the model selected in MacWhisper."),
};

/**
 * One server + transport per request. This is the SDK's stateless recipe: a
 * shared instance carries per-connection initialization state, so the second
 * request on a shared transport fails.
 */
function makeServer(): McpServer {
  const server = new McpServer({ name: "macwhisper", version: "1.0.0" });

  server.registerTool(
    "transcribe_start",
    {
      title: "Start transcribing audio or video with MacWhisper",
      description:
        "Start transcribing a media file that sits in the shared transcribe directory, using MacWhisper on the host " +
        "Mac. Runs locally on the GPU — nothing is uploaded. Pass the file name only (e.g. \"episode.mp3\"), not a " +
        "path. Returns immediately; poll transcribe_status with the same arguments for the result. A long " +
        "recording takes several minutes — check back every minute or two and say you're still waiting between checks.",
      inputSchema: fileArgs,
    },
    async ({ file, language, model }) => {
      const resolved = resolveTarget(file);
      if ("fail" in resolved) return fail(resolved.fail);

      const existing = jobs.get(jobKey(file, language, model));
      if (existing?.status === "running") {
        const elapsedSec = Math.round((Date.now() - existing.startedAt) / 1000);
        return {
          content: [
            { type: "text" as const, text: `Already transcribing ${file} (${elapsedSec}s so far). Poll transcribe_status.` },
          ],
        };
      }

      runJob(file, resolved.target, language, model);
      return {
        content: [{ type: "text" as const, text: `Started transcribing ${file}. Poll transcribe_status for the result.` }],
      };
    },
  );

  server.registerTool(
    "transcribe_status",
    {
      title: "Check a MacWhisper transcription job",
      description:
        "Check the status of a transcription started with transcribe_start. Pass the same file/language/model. " +
        "Returns the transcript once done, an error if MacWhisper failed, or how long it's been running.",
      inputSchema: fileArgs,
    },
    async ({ file, language, model }) => {
      const job = jobs.get(jobKey(file, language, model));
      if (!job) return fail(`No transcription job for ${file}. Call transcribe_start first.`);

      const elapsedSec = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
      if (job.status === "running") {
        return {
          content: [{ type: "text" as const, text: `Still transcribing ${file} — ${elapsedSec}s elapsed. Check again shortly.` }],
        };
      }
      if (job.status === "error") return fail(job.error ?? `MacWhisper failed on ${file}.`);
      return { content: [{ type: "text" as const, text: job.result ?? "" }] };
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
    transport.close().catch((err) => console.error("transport close failed", err));
    server.close().catch((err) => console.error("server close failed", err));
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
