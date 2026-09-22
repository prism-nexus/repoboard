---
id: RCB-88
title: "seat --up cannot refresh the seat's OWN standing bullet without --force (RCB-87 follow-up): a seat that lands a card mid-session and wants its SEATS line to say so hits the second-UP guard and must --force, which appends an audit block each time. Options: an --update flag that rewrites the body but keeps the stamp, or a session token (env REPOBOARD_SESSION) that lets the same session re-UP. Owner picks; until then the practice is restamp at stand-up and stand-down only."
status: decide
priority: low
size: S
labels:
  - seat
decision:
  question: A seat that lands a card mid-session cannot refresh its own UP bullet without --force (the RCB-87 guard cannot tell sessions apart). Which shape?
  options:
    - letter: A
      text: "--update flag: rewrites the body, keeps the standing stamp, no guard, no audit block"
    - letter: B
      text: "session token: REPOBOARD_SESSION env written into the bullet; the same token may re-UP without --force"
    - letter: C
      text: "leave it: restamp at stand-up and stand-down only; --force with audit for anything else"
  askedBy: repoboard builder
  askedAt: 2026-09-22T03:08:26Z
  returnTo: backlog
  chosen: null
  words: null
  decidedBy: null
  decidedAt: null
created: 2026-09-22T03:03:22Z
updated: 2026-09-22T03:08:28Z
---

## Log
- 2026-09-22T03:08:26Z repoboard builder — moved backlog → decide
- 2026-09-22T03:08:26Z repoboard builder — asked: A seat that lands a card mid-session cannot refresh its own UP bullet without --force (the RCB-87 guard cannot tell sessions apart). Which shape? [A|B|C]
- 2026-09-22T03:08:28Z repoboard builder — moved decide → decide
