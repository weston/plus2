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
2. [ ] Unified ranked queue: one "Find Race" → human-in-range → recent ghost → synthetic seed.
3. [ ] Ghost pool growth (ranked races + practice solves, opt-out).
4. [ ] Frontend: unified Find Race + Ghost/Live opponent labels + opt-out toggle.
5. [ ] Post-solve review screen (new tab, step through your solution).
6. [ ] Audit live opponent-move streaming (race preview accuracy).

Also done: auto-stop timer when the cube is detected solved (all modes).
