---
"@birdybeep/agent-core": patch
---

Security: stop exposing the durable machine token on the macOS `security` command line.
The macOS keychain backend previously stored the token via `security add-generic-password
… -w <token>`, placing the secret in the child process's argument vector — which is
world-readable on macOS (`ps -axo args` shows other users' args), so any co-located local
process could scrape the token during a login/rotation write. The backend now passes `-w` as
the final option (the prompt form) and feeds the token to `security` over stdin, so it never
appears in the process table. The write is verified with a read-back, because a desynced
prompt makes `security` store an empty item yet still exit 0.
