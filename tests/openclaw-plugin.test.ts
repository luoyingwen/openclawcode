import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPromptProgressTracker,
  formatDiagnosticVersion,
  readBuildInfoFile,
  resolvePromptProgressMessage,
  splitOutboundMessageText,
} from "../src/openclaw-plugin.js";

describe("openclaw-plugin outbound chunking", () => {
  it("keeps short text as a single chunk", () => {
    expect(splitOutboundMessageText("hello", 20_000)).toEqual(["hello"]);
  });

  it("prefers splitting on newline boundaries", () => {
    const input = ["# Title", "", "Line 1", "Line 2", "Line 3"].join("\n");

    expect(splitOutboundMessageText(input, 12)).toEqual(["# Title\n\n", "Line 1\n", "Line 2\n", "Line 3"]);
  });
});

describe("openclaw-plugin progress messages", () => {
  it("emits thinking only once for tracked sessions", () => {
    const tracker = createPromptProgressTracker("root-session");
    const event = {
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "root-session",
          type: "reasoning",
        },
      },
    };

    expect(resolvePromptProgressMessage(event, tracker)).toEqual({
      text: "💭 正在思考...",
      format: "text",
    });
    expect(resolvePromptProgressMessage(event, tracker)).toBeUndefined();
  });

  it("tracks child sessions and formats running bash tools", () => {
    const tracker = createPromptProgressTracker("root-session");

    resolvePromptProgressMessage(
      {
        type: "session.created",
        properties: {
          info: {
            id: "child-session",
            parentID: "root-session",
          },
        },
      },
      tracker,
    );

    const message = resolvePromptProgressMessage(
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "child-session",
            messageID: "message-1",
            callID: "call-1",
            tool: "bash",
            type: "tool",
            state: {
              status: "running",
              input: {
                command: "pnpm test -- extensions/openclawcode/tests/openclaw-plugin.test.ts",
              },
            },
          },
        },
      },
      tracker,
    );

    expect(message).toMatchObject({ format: "text" });
    expect(message?.text).toContain("terminal");
    expect(message?.text).toContain("pnpm test");
    expect(
      resolvePromptProgressMessage(
        {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: "child-session",
              messageID: "message-1",
              callID: "call-1",
              tool: "bash",
              type: "tool",
              state: {
                status: "running",
                input: {
                  command: "pnpm test -- extensions/openclawcode/tests/openclaw-plugin.test.ts",
                },
              },
            },
          },
        },
        tracker,
      ),
    ).toBeUndefined();
  });
});

describe("openclaw-plugin build info", () => {
  it("reads build-info.json and prefers its timestamp in the version string", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclawcode-build-info-"));
    const buildInfoPath = path.join(tempDir, "build-info.json");

    try {
      fs.writeFileSync(
        buildInfoPath,
        `${JSON.stringify(
          {
            version: "0.15.0",
            builtAt: "2026-04-06T22:12:38.558+08:00",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const buildInfo = readBuildInfoFile(buildInfoPath);

      expect(buildInfo).toEqual({
        version: "0.15.0",
        builtAt: "2026-04-06T22:12:38.558+08:00",
      });
      expect(formatDiagnosticVersion(buildInfo, "0.0.0")).toBe(
        "v0.15.0 @ 2026-04-06T22:12:38.558+08:00",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
