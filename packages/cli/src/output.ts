import type { IntegrationStatus } from "@birdybeep/agent-core";

export function integrationLabel(status: IntegrationStatus): string {
  return {
    installed: "ready",
    needs_trust: "trust hooks to enable notifications",
    needs_restart: "restart to enable notifications",
    not_detected: "not installed",
    unknown: "not set up",
    error: "configuration needs attention",
    revoked: "pairing revoked",
  }[status];
}

export function integrationMark(status: IntegrationStatus): string {
  return status === "installed" ? "✓" : status === "not_detected" ? "–" : "!";
}

export function integrationAction(harness: string, status: IntegrationStatus): string | undefined {
  if (status === "revoked") return "Run `birdybeep pair` to reconnect this machine.";
  if (status === "needs_trust") return "Open Codex, run /hooks, and approve the BirdyBeep hooks.";
  if (status === "needs_restart") return "Restart OpenCode, then run a turn.";
  if (status === "unknown") {
    return `Run \`birdybeep agent install ${harness === "claude_code" ? "claude" : harness}\`.`;
  }
  if (status === "error") return "Run `birdybeep doctor` for the fix.";
  return undefined;
}

/** Simplify known install instructions; retain migration alarms and other adapter remedies. */
export function installAction(action: string): string | undefined {
  if (action === "Codex hooks installed." || action === "BirdyBeep plugin added to OpenCode.")
    return undefined;
  if (
    action ===
    "Open Codex and run /hooks. Status changes from needs_trust after a lifecycle hook fires."
  )
    return "Open Codex and run /hooks to approve the BirdyBeep hooks, then run a turn.";
  if (
    action ===
    "Restart OpenCode. Status changes from needs_restart after the plugin emits an event."
  )
    return "Restart OpenCode, then run a turn to activate notifications.";
  return action;
}

export function queueSummary(
  before: number,
  delivered: number,
  remaining: number,
  dropped = 0,
): string {
  const text =
    remaining > 0
      ? `${remaining} event${remaining === 1 ? "" : "s"} waiting to retry${delivered > 0 ? `; ${delivered} sent` : ""}`
      : delivered > 0
        ? `${delivered} event${delivered === 1 ? "" : "s"} sent; empty`
        : before > 0
          ? "empty (pending events expired or were removed)"
          : "empty";
  return text + (dropped > 0 ? `; ${dropped} dropped by the queue cap` : "");
}

/** Wrap prose without splitting copyable links, paths, command spans, or QR pixels. */
export function wrapTerminalText(text: string, columns: number): string {
  const width = Math.max(24, columns);
  return text
    .split("\n")
    .map((line) => {
      if (
        line.length <= width ||
        /[█▀▄]/u.test(line) ||
        line.includes(String.fromCharCode(27) + "[")
      )
        return line;
      const marker = line.match(/^\s*(?:[✓✗!⚠•·–→]\s+)?/u)?.[0] ?? "";
      // Detailed coverage tables have several aligned columns; preserve their layout.
      if (/\S {2,}\S.*\S {2,}\S/u.test(line.slice(marker.length))) return line;
      // Help has two columns: keep the command/flag intact and wrap its description beneath it.
      const aligned = line.match(/^(\s+\S(?:.*?\S)? {2,})(\S.*)$/u);
      const prefix = aligned?.[1] ?? marker;
      const body = line.slice(prefix.length);
      const words = body.match(/`[^`]*`|\S+/gu) ?? [];
      const indent = " ".repeat(Math.max(2, prefix.length));
      const lines: string[] = [];
      let current = prefix;
      for (const word of words) {
        const separator =
          current.trim().length > 0 && current !== prefix && current !== indent ? " " : "";
        if (
          current.length + separator.length + word.length > width &&
          current !== prefix &&
          current !== indent
        ) {
          lines.push(current);
          current = indent + word;
        } else {
          current += separator + word;
        }
      }
      lines.push(current);
      return lines.join("\n");
    })
    .join("\n");
}
