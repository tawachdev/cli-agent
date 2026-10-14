import { describe, expect, it } from "bun:test";
import { sanitizeEngineData } from "../src/tui/chat";
import { stripTerminalControls } from "../src/tui/term";

describe("untrusted text never reaches the terminal as control sequences", () => {
  it("strips CSI, OSC, DCS, C1 and bare control characters", () => {
    const hostile =
      "ok\x1b[2J\x1b[H\x1b]0;pwned\x07\x1b]8;;http://evil\x1b\\link\x1b]8;;\x1b\\\x1bP+q\x1b\\\x9b31m\r\x08\x07done";
    expect(stripTerminalControls(hostile)).toBe("oklinkdone");
  });

  it("keeps newlines, tabs, and non-ASCII text", () => {
    expect(stripTerminalControls("a\tb\nhé \u{1F44B}")).toBe("a\tb\nhé \u{1F44B}");
  });

  it("cleans every string inside an engine event, however deep", () => {
    const event = {
      type: "tool.result",
      payload: { error: "\x1b[31mred", list: ["\x1b]0;t\x07x"], nested: { n: 1, s: "\x1b[1mb" } },
    };
    expect(sanitizeEngineData(event)).toEqual({
      type: "tool.result",
      payload: { error: "red", list: ["x"], nested: { n: 1, s: "b" } },
    });
  });
});
