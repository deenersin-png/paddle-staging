// ==========================================================================
// Paddle App — the home-screen state machine.
//
// Pure. Given a normalised run, the minute of the day, and (optionally) the
// GTFS trips for each of the run's blocks, decide what the operator is doing
// and what the next scheduled moment is. The caller turns targetMin into a
// ticking countdown.
//
// This module imports pa-schedule.js only. It must never import pa-live.js:
// the target it returns is always a SCHEDULED time.
// ==========================================================================

import { blockStatus } from './pa-schedule.js';

export const PHASES = {
  before_report:   'Report',
  before_pullout:  'Pull-out',
  first_departure: 'First departure',
  in_service:      'Next departure',
  layover:         'Next departure',
  pull_in:         'Pull-in',
  in_piece:        'Piece ends',
  swing:           'Next piece',
  finishing:       'Finish',
  done:            'Done for today'
};

/**
 * @param run          normalised run from pa-schedule.getRun()
 * @param nowMin       minutes since the run date's midnight (may exceed 1440)
 * @param tripsByBlock Map block -> trips[] (may be empty / missing)
 */
export function computeState({ run, nowMin, tripsByBlock }) {
  if (!run) return { phase: 'none' };
  const R = run;

  if (R.reportMin != null && nowMin < R.reportMin) {
    return { phase: 'before_report', targetMin: R.reportMin, piece: R.pieces[0] || null };
  }
  const p0 = R.pieces[0];
  if (p0 && p0.startMin != null && nowMin < p0.startMin) {
    return { phase: 'before_pullout', targetMin: p0.startMin, piece: p0 };
  }

  for (let i = 0; i < R.pieces.length; i++) {
    const p = R.pieces[i];
    const inPiece = p.startMin != null && p.endMin != null && nowMin >= p.startMin && nowMin <= p.endMin;
    if (inPiece) {
      const trips = (tripsByBlock && tripsByBlock.get(p.block)) || [];
      if (trips.length) {
        const st = blockStatus(trips, nowMin);
        if (st.state === 'not_started') {
          return { phase: 'first_departure', targetMin: st.next.s, piece: p, next: st.next,
                   from: st.next.first, to: st.next.last };
        }
        if (st.state === 'in_service') {
          if (st.next) {
            return { phase: 'in_service', targetMin: st.next.s, piece: p, trip: st.trip, next: st.next,
                     from: st.next.first, to: st.next.last, arriveMin: st.trip.e, arriveAt: st.trip.last };
          }
          return { phase: 'in_service', targetMin: st.trip.e, piece: p, trip: st.trip, next: null,
                   lastTrip: true, from: st.trip.first, to: st.trip.last, arriveMin: st.trip.e, arriveAt: st.trip.last };
        }
        if (st.state === 'layover') {
          return { phase: 'layover', targetMin: st.next.s, piece: p, trip: st.prev, next: st.next,
                   from: st.next.first, to: st.next.last, sinceMin: st.prev.e, at: st.prev.last };
        }
        return { phase: 'pull_in', targetMin: p.endMin, piece: p };
      }
      return { phase: 'in_piece', targetMin: p.endMin, piece: p,
               labelOverride: p.endType === 'I' ? 'Pull-in' : null };
    }
    if (p.startMin != null && nowMin < p.startMin) {
      return { phase: 'swing', targetMin: p.startMin, piece: p };
    }
  }

  if (R.finishMin != null && nowMin < R.finishMin) return { phase: 'finishing', targetMin: R.finishMin };
  return { phase: 'done' };
}

export function phaseLabel(st) {
  if (!st) return '';
  if (st.labelOverride) return st.labelOverride;
  if (st.phase === 'in_service' && st.lastTrip) return 'Arrive';
  return PHASES[st.phase] || '';
}
