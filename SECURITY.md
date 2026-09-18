# Security Policy

## Supported versions

`0.1.x` — this project is pre-1.0; there is only one supported line.

## Threat model

The dashboard binds `127.0.0.1` only and never accepts remote connections (README "The idea":
"nothing leaves the machine (the server binds `127.0.0.1`)"; the literal default is set in
`packages/server/src/http.ts:663`, `const host = opts.host ?? '127.0.0.1';`). The store reads and
writes `.repoboard/` in the repo it serves and nothing else — `serve --root` on a foreign
directory is read-only and writes nothing there. No data leaves the machine: there is no
telemetry and no network call other than the local dashboard connection itself.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (the repository's Security tab → "Report a
vulnerability") rather than a public issue. The owner must enable this feature on the repository
for it to be available; if it is not yet, open a regular issue flagged `security` with as little
detail as practical and ask for a private channel.

Target acknowledgement time: none is promised. This is a pre-1.0, small-maintainer project —
reports get best-effort attention, not a service-level agreement.
