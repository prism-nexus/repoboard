# Next agent — three lines

1. Build once, then `repoboard seat <your seat>` — it prints your SEATS line, your last log
   block, the coordinator's, your next card and the open decisions. That is the cold start.
2. Take the card: `repoboard card move <id> doing --as <seat>`; log as you go
   (`repoboard log --as <seat>`); `repoboard check` before you start and before you stop.
3. Stand down: log block first, then `repoboard seat <seat> --down "<≤3 lines>"` LAST.
