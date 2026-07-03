# plus2 — Backlog / TODO

Future ideas (not scheduled). Captured from design discussions.

## Profile & identity
- [ ] WCA profile integration — link a user's WCA ID, pull official records/PBs.
- [ ] Badges for major wins / records (e.g. tournament wins, sub-X milestones, league promotions).
- [ ] Richer public profile + match/solve history view.

## Auth
- [ ] Gmail / Google SSO (sign in with Google).

---

## In-progress feature: ranked / matchmaking redesign
Tracked separately; see commits. Phases:
1. [x] Ghost rating rules (reduced-K, owner frozen, ranked-counting) + shared constants.
2. [x] Unified ranked queue: one "Find Race" → human-in-range → recent ghost →
       record-your-own-solves. Shipped 2026-07-03 (commit 2827657), orchestrated
       client-side (queue page timer + navigation). Remaining slivers:
   - [ ] Flip to server-driven orchestration (`SERVER_GHOST_FALLBACK` in
         matchmaking.gateway.ts is coded but `false`; client timer is authoritative today).
   - [ ] Wire in the synthetic-seed tier: `buildSeedGhost` (solo.service.ts) exists but is
         only reachable via the gated-off server fallback — live tier 3 is "record 5 solves"
         instead of racing a seeded opponent.
3. [ ] Ghost pool growth (ranked races + zen solves; no opt-out — all solves feed the pool).
4. [ ] Frontend: unified Find Race [x done in phase 2] + Ghost/Live opponent labels (still open).
5. [ ] Post-solve review screen (new tab, step through your solution).
6. [ ] Audit live opponent-move streaming (race preview accuracy). Partly addressed by the
       trailing-move fix in 2827657 (opponent view now ends solved); full audit still open.

Also done: auto-stop timer when the cube is detected solved (all modes).
