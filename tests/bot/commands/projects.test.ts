import { describe, expect, it } from "vitest";
import {
  buildProjectButtonLabel,
  getProjectFolderName,
} from "../../../src/bot/commands/projects.js";

describe("bot/commands/projects", () => {
  describe("getProjectFolderName", () => {
    it("extracts folder name from unix path", () => {
      expect(getProjectFolderName("/Users/evan/work/opencode-telegram-bot")).toBe(
        "opencode-telegram-bot",
      );
    });

    it("extracts folder name from windows path", () => {
      expect(getProjectFolderName("C:\\work\\my-project")).toBe("my-project");
    });

    it("handles trailing separators", () => {
      expect(getProjectFolderName("/var/www/project/")).toBe("project");
      expect(getProjectFolderName("C:\\repo\\project\\")).toBe("project");
    });
  });

  describe("buildProjectButtonLabel", () => {
    it("formats label as index + folder + full path", () => {
      expect(buildProjectButtonLabel(0, "/Users/evan/work/opencode-telegram-bot")).toBe(
        "1. [opencode-telegram-bot][/Users/evan/work/opencode-telegram-bot]",
      );
    });

    it("formats windows path label", () => {
      expect(buildProjectButtonLabel(3, "D:\\repo\\awesome")).toBe(
        "4. [awesome][D:\\repo\\awesome]",
      );
    });
  });
});
