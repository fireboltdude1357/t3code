import { assert, it } from "@effect/vitest";

import {
  codexChildEnvironment,
  sessionThreadStartParams,
  VOICE_MCP_SERVER,
} from "./CodexSessions.ts";
import { VOICE_SESSION_TOOLS } from "./VoiceSessionService.ts";

it("drops the API key and T3 variables from the Codex child environment", () => {
  const environment = codexChildEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/home/tanner",
      OPENAI_API_KEY: "sk-live",
      T3_SERVICE_LAUNCHER_CONTEXT: "daily",
      T3CODE_HOME: "/home/tanner/.t3",
      UNSET: undefined,
    },
    "/tmp/codex-home",
  );
  assert.deepStrictEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/home/tanner",
    CODEX_HOME: "/tmp/codex-home",
  });
});

it("starts session threads read-only with every voice tool pre-approved", () => {
  const params = sessionThreadStartParams({
    workspaceRoot: "/tmp/voice",
    mcpUrl: "http://127.0.0.1:4000/mcp",
    token: "secret",
  });
  assert.strictEqual(params.approvalPolicy, "never");
  assert.strictEqual(params.sandbox, "read-only");
  assert.strictEqual(params.cwd, "/tmp/voice");
  assert.deepStrictEqual(params.config, {
    mcp_servers: {
      [VOICE_MCP_SERVER]: {
        url: "http://127.0.0.1:4000/mcp",
        http_headers: { Authorization: "Bearer secret" },
        tools: Object.fromEntries(
          VOICE_SESSION_TOOLS.map((tool) => [tool, { approval_mode: "approve" }]),
        ),
      },
    },
  });
});
