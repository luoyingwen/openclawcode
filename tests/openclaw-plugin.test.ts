import { describe, expect, it } from "vitest";
import {
  createPromptProgressTracker,
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
