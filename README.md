# macwhisper-mcp

MacWhisper transcription as an MCP tool, over streamable HTTP.

[MacWhisper](https://www.macwhisper.com/)'s `mw` CLI is a macOS binary that talks to the running app over a local socket. A Linux container can neither execute it nor reach that socket, so a containerised agent cannot transcribe through MacWhisper directly. This server runs on the Mac, exposes one `transcribe` tool, and listens on loopback. Containers reach it at `http://host.docker.internal:10256/mcp`.

Transcription runs on the Mac's GPU with whatever model MacWhisper has selected. Nothing is uploaded, and no API key is involved.

## Requirements

- macOS with MacWhisper installed and licensed
- MacWhisper's CLI enabled: Settings → Advanced → Command-Line Tool → Install (puts `mw` at `/usr/local/bin/mw`)
- [bun](https://bun.sh)

## Install

```sh
bun install
sh install.sh
```

`install.sh` generates a launchd user agent that keeps the server running, and a 0600 `.token` on first run. It prints the wiring command for the token.

## The tool

```
transcribe({ file, language?, model? })
```

- `file` — **a file name, not a path**, e.g. `"episode.mp3"`. Only files sitting directly in the transcribe directory are visible, and symlinks out of it are refused. That keeps this a transcription service rather than a container-to-host file reader.
- `language` — ISO 639-1 (`"en"`, `"zh"`) or `"auto"`. Defaults to MacWhisper's setting.
- `model` — `engine:model-id` form. Defaults to the model selected in MacWhisper. Worth setting explicitly for non-English audio: Parakeet is English-only, while `whisper-cpp:ggml-model-whisper-turbo` handles both. Run `mw models` for what's available.

The call blocks until MacWhisper finishes and returns the transcript as text, so a caller has nothing to poll for. A long recording takes several minutes.

## Configuration

| Variable | Default |
|---|---|
| `MACWHISPER_MCP_DIR` | `~/nanoclaw-transcribe` — the directory the tool can read |
| `MACWHISPER_MCP_PORT` | `10256` |
| `MACWHISPER_MCP_TOKEN` | contents of `.token` |

The caller puts media in that directory, then names the file. Mount it into the container if the agent does the downloading.

## Access

Loopback is not an access boundary — every local process can reach the port — so requests need `Authorization: Bearer <token>`, compared with `timingSafeEqual`. With [NanoClaw](https://github.com/nanocoai/nanoclaw):

```sh
ncl groups config add-mcp-server --id <group-id> --name macwhisper \
  --url http://host.docker.internal:10256/mcp \
  --headers "{\"Authorization\":\"Bearer $(cat .token)\"}"
```

If no token is configured the server accepts every request rather than pretending to be gated.

## Check

```sh
sh check.sh
```

Runs the guards against a live server: no token is refused, path separators are refused, a missing file is named, and a symlink out of the directory is refused.

## Licence

MIT
