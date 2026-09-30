import { describe, expect, it } from "vitest";

import { createIo } from "./framework";
import {
  installAction,
  integrationAction,
  integrationLabel,
  queueSummary,
  wrapTerminalText,
} from "./output";

describe("readable terminal output", () => {
  it("wraps prose with hanging indentation while keeping commands and links copyable", () => {
    const text =
      "  → Open Codex and trust the hooks, then run `birdybeep status --verbose` to check your setup.";
    const wrapped = wrapTerminalText(text, 48);
    expect(wrapped).toContain("\n    ");
    expect(wrapped).toContain("`birdybeep status --verbose`");
    expect(wrapped.split("\n").every((line) => line.length <= 48)).toBe(true);
    expect(wrapped.replace(/\s+/gu, " ").trim()).toBe(text.replace(/\s+/gu, " ").trim());
    const url = "https://birdybeep.com/pair/ABCDE#secret-fragment-kept-whole";
    expect(wrapTerminalText(`Open the complete link: ${url}`, 32)).toContain(url);
    expect(wrapTerminalText("██ ████\n██ ██", 24)).toBe("██ ████\n██ ██");
  });

  it("names the real next step for pending and revoked integrations", () => {
    expect(integrationLabel("needs_trust")).toContain("trust hooks");
    expect(integrationAction("codex", "needs_trust")).toContain("/hooks");
    expect(integrationAction("opencode", "needs_restart")).toContain("Restart OpenCode");
    expect(integrationAction("codex", "revoked")).toContain("birdybeep pair");
    expect(integrationAction("claude_code", "unknown")).toContain("agent install claude");
    expect(integrationAction("codex", "installed")).toBeUndefined();
    expect(integrationAction("codex", "not_detected")).toBeUndefined();
  });

  it("distinguishes an empty queue, a successful drain, pending retries, and cap loss", () => {
    expect(queueSummary(0, 0, 0)).toBe("empty");
    expect(queueSummary(1, 1, 0)).toBe("1 event sent; empty");
    expect(queueSummary(3, 1, 2, 4)).toBe(
      "2 events waiting to retry; 1 sent; 4 dropped by the queue cap",
    );
    expect(queueSummary(1, 0, 0)).toContain("expired or were removed");
  });
});

it("wraps human TTY output at narrow and normal widths while leaving JSON and QR bytes intact", () => {
  const prose =
    "Open Codex and approve the hooks, then run `birdybeep status` to check the connection to your phone.";
  for (const columns of [44, 80]) {
    let text = "";
    const writer = {
      isTTY: true,
      columns,
      write: (chunk: string) => {
        text += chunk;
      },
    };
    const io = createIo(false, writer, writer);
    io.line(prose);
    expect(
      text
        .trim()
        .split("\n")
        .every((line) => line.length <= columns),
    ).toBe(true);
    expect(text.replace(/\s+/gu, " ").trim()).toBe(prose);
    text = "";
    const qr = "█▀▄".repeat(40);
    io.line(qr);
    expect(text).toBe(qr + "\n");
    text = "";
    createIo(true, writer, writer).emit(prose, { detail: prose });
    expect(JSON.parse(text)).toEqual({ detail: prose });
    expect(text.trim().split("\n")).toHaveLength(1);
  }
});

it("simplifies standard activation instructions but preserves migration and recovery warnings", () => {
  expect(installAction("Codex hooks installed.")).toBeUndefined();
  expect(
    installAction(
      "Open Codex and run /hooks. Status changes from needs_trust after a lifecycle hook fires.",
    ),
  ).toContain("approve the BirdyBeep hooks");
  const migration = "Remove an old notify entry only after the new lifecycle hooks are trusted.";
  expect(installAction(migration)).toBe(migration);
});

it("wraps aligned help descriptions under their command while retaining detailed tables", () => {
  const line = "  status         See what is connected and what needs attention";
  const wrapped = wrapTerminalText(line, 44);
  expect(wrapped.split("\n").every((row) => row.length <= 44)).toBe(true);
  expect(wrapped).toContain("\n                 ");
  const table = "✓  Claude Code         terminal CLI 2.1.227         ready";
  expect(wrapTerminalText(table, 44)).toBe(table);
});
