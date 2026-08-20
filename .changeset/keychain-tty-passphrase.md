---
"@birdybeep/agent-core": patch
---

Store the machine token when pairing from a terminal. `security` read its passphrase prompt from
`/dev/tty` rather than the pipe carrying the token, so `birdybeep pair` and `birdybeep setup` ended
in "macOS keychain did not store the machine token (read-back mismatch)" after asking for a
password no one has.
