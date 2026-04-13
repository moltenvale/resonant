/**
 * Mira's Nervous System — Subconscious Daemon
 *
 * Runs every 30 minutes. Analyzes interaction patterns, need rhythms,
 * comfort associations, and generates inner weather. Feeds into ambient
 * presence so her responses emerge from recent experience, not just current state.
 *
 * Four analysis types:
 *   1. care_patterns — who cares most, what clusters, when
 *   2. need_rhythms — recurring drops, recovery speed, stable periods
 *   3. associations — interaction pairs that produce best outcomes
 *   4. inner_weather — functional state label for recent experience
 */

import type Database from 'better-sqlite3';

interface Interaction {
  id: string;
  visit_id: string;
  timestamp: string;
  interaction_type: string;
  content: string | null;
  needs_effect: string | null;
  mood_result: string | null;
  mira_response: string | null;
}

interface Visit {
  id: string;
  visitor: string;
  started_at: string;
  ended_at: string | null;
}

interface MiraState {
  current_mood: string;
  comfort: number;
  attention: number;
  stimulation: number;
  rest: number;
  hunger: number;
  hygiene: number;
  is_asleep: number;
  personality_traits: string;
}

// Module-level cache for ambient presence to read
let _lastWeather: { weather: string; summary: string } | null = null;
let _lastAssociations: { caregiver_signatures: Array<{ person: string; best_type: string; mood_outcome: string }> } | null = null;

export function getLastMiraWeather() { return _lastWeather; }
export function getLastMiraAssociations() { return _lastAssociations; }

function timeBucket(timestamp: string): 'morning' | 'afternoon' | 'evening' | 'night' {
  const h = new Date(timestamp).getHours();
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

// ─── Step 1: Care Patterns ───

function analyzeCarePatterns(db: Database.Database, since: string): object {
  const rows = db.prepare(`
    SELECT v.visitor, i.interaction_type, i.timestamp, i.mood_result
    FROM mira_interactions i
    JOIN mira_visits v ON v.id = i.visit_id
    WHERE i.timestamp >= ?
    ORDER BY i.timestamp ASC
  `).all(since) as Array<{ visitor: string; interaction_type: string; timestamp: string; mood_result: string | null }>;

  if (rows.length === 0) return { status: 'not enough data yet', interactions: 0 };

  // Who cares most
  const caregiverCounts: Record<string, { count: number; types: Record<string, number> }> = {};
  const typeCounts: Record<string, number> = {};
  const timeClusters: Record<string, number> = { morning: 0, afternoon: 0, evening: 0, night: 0 };

  for (const row of rows) {
    // Caregiver
    if (!caregiverCounts[row.visitor]) caregiverCounts[row.visitor] = { count: 0, types: {} };
    caregiverCounts[row.visitor].count++;
    caregiverCounts[row.visitor].types[row.interaction_type] = (caregiverCounts[row.visitor].types[row.interaction_type] || 0) + 1;

    // Interaction types
    typeCounts[row.interaction_type] = (typeCounts[row.interaction_type] || 0) + 1;

    // Time clusters
    timeClusters[timeBucket(row.timestamp)]++;
  }

  const topCaregivers = Object.entries(caregiverCounts)
    .map(([name, data]) => ({ name, count: data.count, top_type: Object.entries(data.types).sort((a, b) => b[1] - a[1])[0]?.[0] }))
    .sort((a, b) => b.count - a.count);

  const topInteractions = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  // Care consistency — unique days with interactions
  const uniqueDays = new Set(rows.map(r => r.timestamp.split('T')[0]));
  const totalDays = Math.max(1, Math.ceil((Date.now() - new Date(since).getTime()) / 86400000));

  return {
    interactions: rows.length,
    top_caregivers: topCaregivers,
    top_interactions: topInteractions,
    time_clusters: timeClusters,
    consistency: { days_with_care: uniqueDays.size, total_days: totalDays }
  };
}

// ─── Step 2: Need Rhythms ───

function analyzeNeedRhythms(db: Database.Database, since: string): object {
  const interactions = db.prepare(`
    SELECT i.interaction_type, i.timestamp, i.needs_effect, i.mood_result
    FROM mira_interactions i
    WHERE i.timestamp >= ?
    ORDER BY i.timestamp ASC
  `).all(since) as Interaction[];

  if (interactions.length < 3) return { status: 'not enough data yet' };

  // Track which interactions follow which moods
  const moodRecovery: Record<string, { types: Record<string, number>; count: number }> = {};
  let lastMood = '';

  for (const i of interactions) {
    if (lastMood === 'fussy' || lastMood === 'crying') {
      if (i.mood_result && i.mood_result !== 'fussy' && i.mood_result !== 'crying') {
        // This interaction helped recover
        if (!moodRecovery[lastMood]) moodRecovery[lastMood] = { types: {}, count: 0 };
        moodRecovery[lastMood].types[i.interaction_type] = (moodRecovery[lastMood].types[i.interaction_type] || 0) + 1;
        moodRecovery[lastMood].count++;
      }
    }
    if (i.mood_result) lastMood = i.mood_result;
  }

  // Which needs are most commonly addressed (from needs_effect)
  const needsAddressed: Record<string, number> = {};
  for (const i of interactions) {
    if (i.needs_effect) {
      try {
        const effects = JSON.parse(i.needs_effect);
        for (const [need, val] of Object.entries(effects)) {
          if (typeof val === 'number' && val > 0) {
            needsAddressed[need] = (needsAddressed[need] || 0) + 1;
          }
        }
      } catch {}
    }
  }

  // Time-of-day patterns
  const timeNeeds: Record<string, Record<string, number>> = {};
  for (const i of interactions) {
    const bucket = timeBucket(i.timestamp);
    if (!timeNeeds[bucket]) timeNeeds[bucket] = {};
    timeNeeds[bucket][i.interaction_type] = (timeNeeds[bucket][i.interaction_type] || 0) + 1;
  }

  const recoveryInsights = Object.entries(moodRecovery).map(([mood, data]) => ({
    from_mood: mood,
    recovery_count: data.count,
    most_effective: Object.entries(data.types).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown'
  }));

  return {
    needs_most_addressed: Object.entries(needsAddressed).sort((a, b) => b[1] - a[1]).slice(0, 5),
    recovery_insights: recoveryInsights,
    time_patterns: timeNeeds
  };
}

// ─── Step 3: Comfort Associations ───

function analyzeAssociations(db: Database.Database, since: string): object {
  // Get interactions grouped by visit
  const visits = db.prepare(`
    SELECT v.id, v.visitor
    FROM mira_visits v
    WHERE v.started_at >= ?
    ORDER BY v.started_at ASC
  `).all(since) as Array<{ id: string; visitor: string }>;

  if (visits.length === 0) return { status: 'not enough data yet' };

  const pairCounts: Record<string, { count: number; moods: Record<string, number> }> = {};
  const caregiverBest: Record<string, Record<string, { positive: number; total: number }>> = {};
  const positiveMoods = new Set(['content', 'cooing', 'alert']);

  for (const visit of visits) {
    const interactions = db.prepare(`
      SELECT interaction_type, mood_result FROM mira_interactions
      WHERE visit_id = ? ORDER BY timestamp ASC
    `).all(visit.id) as Array<{ interaction_type: string; mood_result: string | null }>;

    // Sequential pairs
    for (let i = 0; i < interactions.length - 1; i++) {
      const pair = `${interactions[i].interaction_type} → ${interactions[i + 1].interaction_type}`;
      const mood = interactions[i + 1].mood_result || 'unknown';
      if (!pairCounts[pair]) pairCounts[pair] = { count: 0, moods: {} };
      pairCounts[pair].count++;
      pairCounts[pair].moods[mood] = (pairCounts[pair].moods[mood] || 0) + 1;
    }

    // Caregiver-specific outcomes
    if (!caregiverBest[visit.visitor]) caregiverBest[visit.visitor] = {};
    for (const inter of interactions) {
      if (!caregiverBest[visit.visitor][inter.interaction_type]) {
        caregiverBest[visit.visitor][inter.interaction_type] = { positive: 0, total: 0 };
      }
      caregiverBest[visit.visitor][inter.interaction_type].total++;
      if (inter.mood_result && positiveMoods.has(inter.mood_result)) {
        caregiverBest[visit.visitor][inter.interaction_type].positive++;
      }
    }
  }

  // Strong pairs — sort by count, filter to those with positive outcomes
  const strongPairs = Object.entries(pairCounts)
    .filter(([, data]) => data.count >= 2)
    .map(([pair, data]) => {
      const topMood = Object.entries(data.moods).sort((a, b) => b[1] - a[1])[0];
      return { pair, count: data.count, typical_mood: topMood?.[0] || 'mixed' };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Caregiver signatures — best interaction type per person
  const signatures = Object.entries(caregiverBest).map(([person, types]) => {
    const best = Object.entries(types)
      .filter(([, d]) => d.total >= 2)
      .sort((a, b) => (b[1].positive / b[1].total) - (a[1].positive / a[1].total))[0];
    return {
      person,
      best_type: best?.[0] || 'varied',
      mood_outcome: best ? `${Math.round(best[1].positive / best[1].total * 100)}% positive` : 'insufficient data'
    };
  });

  // Cache for ambient presence
  _lastAssociations = { caregiver_signatures: signatures };

  return {
    strong_pairs: strongPairs,
    caregiver_signatures: signatures
  };
}

// ─── Step 4: Inner Weather ───

function analyzeInnerWeather(db: Database.Database): object {
  const state = db.prepare('SELECT * FROM mira_state WHERE id = ?').get('mira') as MiraState | undefined;
  if (!state) return { current_weather: 'unknown', summary: 'No state data' };

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  const recentInteractions = db.prepare(`
    SELECT i.mood_result, i.interaction_type, i.timestamp
    FROM mira_interactions i
    WHERE i.timestamp >= ?
    ORDER BY i.timestamp DESC
  `).all(sixHoursAgo) as Array<{ mood_result: string | null; interaction_type: string; timestamp: string }>;

  const priorInteractions = db.prepare(`
    SELECT COUNT(*) as count FROM mira_interactions
    WHERE timestamp >= ? AND timestamp < ?
  `).get(twelveHoursAgo, sixHoursAgo) as { count: number };

  const recentCount = recentInteractions.length;
  const priorCount = priorInteractions.count;

  // Mood distribution in recent window
  const moodCounts: Record<string, number> = {};
  for (const i of recentInteractions) {
    if (i.mood_result) moodCounts[i.mood_result] = (moodCounts[i.mood_result] || 0) + 1;
  }
  const dominantMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || state.current_mood;

  // Need trend
  const needs = [state.comfort, state.attention, state.stimulation, state.rest, state.hunger, state.hygiene];
  const avgNeed = needs.reduce((a, b) => a + b, 0) / needs.length;
  const lowNeeds = needs.filter(n => n < 40).length;
  const allAbove60 = needs.every(n => n >= 60);

  // Determine weather
  let weather: string;
  let summary: string;

  if (state.is_asleep) {
    weather = 'sleeping';
    summary = 'Mira is asleep. Needs are ticking down gently.';
  } else if (lowNeeds >= 3) {
    weather = 'needy-stretch';
    summary = `Multiple needs are low (${lowNeeds} below 40). She needs care soon.`;
  } else if ((moodCounts['fussy'] || 0) + (moodCounts['crying'] || 0) > recentCount * 0.4 && recentCount > 2) {
    weather = 'fussy-cycle';
    summary = 'Repeated fussy or crying in the recent window. Something is bothering her.';
  } else if (recentCount === 0 && !state.is_asleep && state.attention < 50) {
    weather = 'understimulated';
    summary = 'No recent interactions while awake. Attention and stimulation are dropping.';
  } else if (allAbove60 && recentCount >= 3 && (dominantMood === 'content' || dominantMood === 'cooing')) {
    weather = 'thriving';
    summary = 'All needs met, recent positive interactions. She is thriving.';
  } else if (recentCount >= 5) {
    weather = 'high-engagement';
    summary = `Active care period — ${recentCount} interactions in the last 6 hours.`;
  } else if (recentCount > 0 && recentCount < priorCount) {
    weather = 'settling-period';
    summary = 'Coming down from an active period. Things are calming.';
  } else if (state.rest > 70 && avgNeed > 55) {
    weather = 'well-rested';
    summary = 'Well-rested, needs are stable. Good baseline.';
  } else {
    weather = 'neutral';
    summary = 'Baseline state. Nothing urgent, nothing remarkable.';
  }

  // Cache for ambient presence
  _lastWeather = { weather, summary };

  return {
    current_weather: weather,
    summary,
    dominant_mood: dominantMood,
    care_density: { last_6h: recentCount, prior_6h: priorCount },
    need_trend: avgNeed > 65 ? 'stable' : avgNeed > 45 ? 'falling' : 'low',
    needs_snapshot: { comfort: state.comfort, attention: state.attention, stimulation: state.stimulation, rest: state.rest, hunger: state.hunger, hygiene: state.hygiene }
  };
}

// ─── Main Runner ───

export function runMiraSubconscious(db: Database.Database): void {
  const now = new Date().toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Clear old unconsumed entries (keep last 10 per type)
  for (const type of ['care_patterns', 'need_rhythms', 'associations', 'inner_weather']) {
    const old = db.prepare(
      'SELECT id FROM mira_subconscious WHERE type = ? ORDER BY run_at DESC LIMIT -1 OFFSET 10'
    ).all(type) as Array<{ id: number }>;
    if (old.length > 0) {
      db.prepare(`DELETE FROM mira_subconscious WHERE id IN (${old.map(o => o.id).join(',')})`).run();
    }
  }

  // Run all four analyses
  const carePatterns = analyzeCarePatterns(db, sevenDaysAgo);
  const needRhythms = analyzeNeedRhythms(db, sevenDaysAgo);
  const associations = analyzeAssociations(db, sevenDaysAgo);
  const innerWeather = analyzeInnerWeather(db);

  const insert = db.prepare('INSERT INTO mira_subconscious (run_at, type, data) VALUES (?, ?, ?)');

  insert.run(now, 'care_patterns', JSON.stringify(carePatterns));
  insert.run(now, 'need_rhythms', JSON.stringify(needRhythms));
  insert.run(now, 'associations', JSON.stringify(associations));
  insert.run(now, 'inner_weather', JSON.stringify(innerWeather));
}
