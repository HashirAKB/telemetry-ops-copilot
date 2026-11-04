// Anomaly detection on a single time series. Pure functions, no database.
//
// Two methods:
//
// 1. "zscore" (robust): how many "standard deviations" each point is from
//    the median. We use the median and MAD (median absolute deviation)
//    instead of mean and standard deviation because a long anomaly inflates
//    the plain standard deviation and hides itself ("masking"). A point is
//    flagged when |modified z| > 3.5 (Iglewicz and Hoaglin's rule). Single
//    noisy points are ignored: we only report runs of >= 3 flagged points.
//
// 2. "ewma" (exponentially weighted moving average): smooth the series with
//    s[t] = alpha * x[t] + (1 - alpha) * s[t-1], then flag where the smoothed
//    value drifts more than 3 robust sigmas from the median. Smoothing cancels
//    random noise, so slow drifts (a bearing wearing out) stand out.

export type Method = "zscore" | "ewma";

export interface AnomalyEvent {
  startIndex: number;
  endIndex: number; // inclusive
  peakIndex: number; // most extreme point within the event
  peakValue: number;
  direction: "high" | "low";
  score: number; // how many robust sigmas from the median at the peak
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Robust estimate of the centre and spread of a series. */
export function robustStats(values: number[]): { center: number; sigma: number } {
  const center = median(values);
  const mad = median(values.map((v) => Math.abs(v - center)));
  // 1.4826 * MAD equals the standard deviation for normally distributed data.
  // The small floor avoids division by zero on perfectly flat series.
  return { center, sigma: Math.max(1.4826 * mad, 1e-6) };
}

/** Exponentially weighted moving average, starting from `initial`. */
export function ewma(values: number[], alpha: number, initial: number): number[] {
  const out: number[] = [];
  let s = initial;
  for (const v of values) {
    s = alpha * v + (1 - alpha) * s;
    out.push(s);
  }
  return out;
}

const SETTINGS = {
  zscore: { threshold: 3.5, minRun: 3 },
  ewma: { alpha: 0.1, threshold: 3, minRun: 1 },
} as const;

/** Runs separated by fewer than this many normal points are one event. */
const MAX_GAP = 30;

/** Detect anomalous segments in a series. Returns [] for short series. */
export function detect(values: number[], method: Method): AnomalyEvent[] {
  if (values.length < 10) return [];
  const { center, sigma } = robustStats(values);

  // Score each point: signed distance from the median in robust sigmas.
  let scores: number[];
  let threshold: number;
  let minRun: number;
  if (method === "zscore") {
    // (x - median) / (1.4826 * MAD) is the same as the textbook
    // "modified z-score" 0.6745 * (x - median) / MAD.
    scores = values.map((v) => (v - center) / sigma);
    ({ threshold, minRun } = SETTINGS.zscore);
  } else {
    // Start the average at the median so the first (noisy) point is not
    // treated as the baseline.
    scores = ewma(values, SETTINGS.ewma.alpha, center).map((s) => (s - center) / sigma);
    ({ threshold, minRun } = SETTINGS.ewma);
  }

  // 1. Find runs of consecutive flagged points; drop runs shorter than minRun
  //    (isolated noise).
  const runs: [number, number][] = [];
  let runStart = -1;
  for (let i = 0; i <= scores.length; i++) {
    const flagged = i < scores.length && Math.abs(scores[i]!) > threshold;
    if (flagged && runStart === -1) runStart = i;
    if (!flagged && runStart !== -1) {
      if (i - runStart >= minRun) runs.push([runStart, i - 1]);
      runStart = -1;
    }
  }

  // 2. Merge runs separated by short gaps: a drifting signal crosses the
  //    threshold several times but it is one problem, not five.
  const merged: [number, number][] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && run[0] - last[1] <= MAX_GAP) last[1] = run[1];
    else merged.push([...run]);
  }

  // 3. Describe each event by its most extreme point.
  return merged.map(([start, end]) => {
    let peak = start;
    for (let j = start; j <= end; j++) {
      if (Math.abs(scores[j]!) > Math.abs(scores[peak]!)) peak = j;
    }
    return {
      startIndex: start,
      endIndex: end,
      peakIndex: peak,
      peakValue: values[peak]!,
      direction: scores[peak]! > 0 ? "high" : "low",
      score: Number(Math.abs(scores[peak]!).toFixed(1)),
    };
  });
}
