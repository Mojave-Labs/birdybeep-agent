# OpenCode configuration

`birdybeep agent install opencode` adds `@birdybeep/opencode` to the plugin array in `$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json`. Existing plugins and settings remain in place.

## Installed entries

```json
{
  "plugin": ["@birdybeep/opencode"]
}
```

The plugin receives OpenCode lifecycle events, removes excluded content, and sends supported events to BirdyBeep.

## Existing configuration

The installer appends the BirdyBeep entry to the existing `plugin` array and preserves other keys. Before the first change, it writes an adjacent `.birdybeep-backup` file.

## Activation

Restart OpenCode after installation. Status remains `needs_restart` until the plugin emits an event.

## Removal

`birdybeep agent uninstall opencode` removes the `@birdybeep/opencode` entry and restores the original configuration where appropriate. Repeated installation does not add duplicate plugin entries.
