import type { WcaAchievements, WcaRecordTier } from '@plus2/shared';
import { CHAMPIONSHIPS } from './championships';

// One row from GET /api/v0/persons/{wcaId}/results (subset we use).
interface WcaResult {
  pos: number;
  round_type_id: string; // 'f' = final, 'c' = combined final, '1'/'2'/'d'/'e'/'g' = earlier rounds
  competition_id: string;
  event_id: string;
  regional_single_record?: string | null; // 'WR' | 'NR' | continental code | '' | null
  regional_average_record?: string | null;
}

// Only finals decide podiums/wins.
const FINAL_ROUNDS = new Set(['f', 'c']);

// Continental record markers (Africa, Asia, Europe, North/South America, Oceania).
const CONTINENTAL_RECORDS = new Set(['AfR', 'AsR', 'ER', 'NAR', 'SAR', 'OcR']);

// Highest record tier from a single marker, or null.
function tierOf(marker: string | null | undefined): WcaRecordTier | null {
  if (marker === 'WR') return 'world';
  if (marker && CONTINENTAL_RECORDS.has(marker)) return 'continental';
  if (marker === 'NR') return 'national';
  return null;
}

const TIER_RANK: Record<WcaRecordTier, number> = { national: 1, continental: 2, world: 3 };

const EVENT_NAMES: Record<string, string> = {
  '333': '3x3', '222': '2x2', '444': '4x4', '555': '5x5', '666': '6x6', '777': '7x7',
  '333bf': '3x3 Blindfolded', '333oh': '3x3 One-Handed', '333fm': 'Fewest Moves',
  '333ft': '3x3 With Feet', 'clock': 'Clock', 'minx': 'Megaminx', 'pyram': 'Pyraminx',
  'skewb': 'Skewb', 'sq1': 'Square-1', '444bf': '4x4 Blindfolded', '555bf': '5x5 Blindfolded',
  '333mbf': '3x3 Multi-Blind',
};

function eventName(id: string): string {
  return EVENT_NAMES[id] || id;
}

function ordinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

// "AustralianNationals2023" -> "Australian Nationals 2023"; "WC2023" -> "World Championship 2023".
function prettyComp(id: string): string {
  if (/^WC\d{4}$/.test(id)) return `World Championship ${id.slice(2)}`;
  return id
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Z])/g, '$1 $2');
}

/**
 * Best podium/win at a *major* championship (World + National only — continental
 * is intentionally excluded per the badge spec). `pos` is the final-round
 * position, so pos 1 = championship win, pos ≤ 3 = podium.
 */
export function classifyChampionshipAchievements(results: WcaResult[]): WcaAchievements {
  const best: Record<'world' | 'national', { bestPos: number; label: string } | null> = {
    world: null,
    national: null,
  };
  let recordTier: WcaRecordTier | null = null;

  for (const r of results) {
    // Records can be set in ANY round (not just finals).
    for (const t of [tierOf(r.regional_single_record), tierOf(r.regional_average_record)]) {
      if (t && (!recordTier || TIER_RANK[t] > TIER_RANK[recordTier])) recordTier = t;
    }

    if (!FINAL_ROUNDS.has(r.round_type_id)) continue;
    if (typeof r.pos !== 'number' || r.pos < 1 || r.pos > 3) continue;
    const raw = CHAMPIONSHIPS[r.competition_id];
    const level = raw === 'world' ? 'world' : raw === 'national' ? 'national' : null;
    if (!level) continue; // skip non-championships and continental

    const cur = best[level];
    if (!cur || r.pos < cur.bestPos) {
      best[level] = {
        bestPos: r.pos,
        label: `${ordinal(r.pos)} · ${eventName(r.event_id)} · ${prettyComp(r.competition_id)}`,
      };
    }
  }

  return { world: best.world, national: best.national, recordTier };
}
