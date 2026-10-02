import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * The session thread behind an MCP request, resolved from its bearer token by
 * the sidecar's MCP middleware. Every voice tool depends on it.
 */
export class VoiceMcpCaller extends Context.Service<
  VoiceMcpCaller,
  { readonly sessionThreadId: ThreadId }
>()("@t3tools/voice/mcp/VoiceMcpCaller") {}
