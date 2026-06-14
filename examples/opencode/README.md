# Example — OpenCode

This is the **exact** config `birdybeep agent install opencode` writes into your OpenCode config at
`~/.config/opencode/opencode.json` (honoring `XDG_CONFIG_HOME`). It is the same artifact the
adapter's snapshot tests assert against — not a hand-written approximation — so what you see here is
what the installer produces.

[`opencode.json`](./opencode.json) shows the **from-scratch** case: a brand-new config with nothing
but BirdyBeep's plugin entry. If you already have an `opencode.json`, the installer merges this entry
in and leaves everything else untouched (see "Non-destructive" below).

## What BirdyBeep adds

Exactly **one** entry — `@birdybeep/opencode` — appended to the top-level `"plugin"` array:

```json
{
  "plugin": ["@birdybeep/opencode"]
}
```

OpenCode installs that package and loads its `BirdyBeepPlugin` export, which observes session and tool
events, normalizes and redacts them, and ships a notification to your phone.

## What you keep

Everything else. The installer only touches the `"plugin"` array, and only to **append** the
BirdyBeep entry. If you already use plugins, yours are kept and BirdyBeep is added alongside them.
Every other key — `$schema`, `theme`, `model`, … — is preserved exactly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight",
  "plugin": ["opencode-helicone-session", "@birdybeep/opencode"],
  "model": "anthropic/claude-sonnet-4-6"
}
```

The original file is backed up once to `~/.config/opencode/opencode.json.birdybeep-backup` before the
first change.

## Restart once (important)

OpenCode loads plugins only at startup, so after install BirdyBeep reports **`needs_restart`**:

> **Restart OpenCode** for the plugin to load. After restart, OpenCode sessions on this machine are
> tracked automatically — the integration goes live on the first real event after the restart.

## No token here

There is **no token in this file**, and there never will be. The plugin reads your machine token from
the OS keychain (or a strict-permission file) at event time. Tokens are never written into harness
config or any repo file. See [`docs/security.md`](../../docs/security.md).

## Reversible

`birdybeep agent uninstall opencode` removes exactly this `@birdybeep/opencode` entry and restores the
original config. Installs are idempotent — running install twice produces this same result, with no
duplicate plugin entry.

## Learn more

- [`docs/install.md`](../../docs/install.md) — install / uninstall flow and the restart step
- [`docs/security.md`](../../docs/security.md) — token storage and exactly what data leaves the machine
