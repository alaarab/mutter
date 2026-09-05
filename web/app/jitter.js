const MAX_REQUIRED_CALM_SECONDS = 240;

export class JitterPolicy {
  constructor({
    minSamples,
    maxSamples,
    growSamples,
    shrinkSamples,
    dangerSamples,
    cushionSamples,
    calmSecondsBeforeShrink,
  }) {
    this.minSamples = minSamples;
    this.maxSamples = maxSamples;
    this.growSamples = growSamples;
    this.shrinkSamples = shrinkSamples;
    this.dangerSamples = dangerSamples;
    this.cushionSamples = cushionSamples;
    this.baseCalmSeconds = calmSecondsBeforeShrink;
    this.requiredCalmSeconds = calmSecondsBeforeShrink;
    this.target = minSamples;
    this.calmSeconds = 0;
    this.shrankLast = false;
  }

  observe({ underruns = 0, lowWater = null, active = false } = {}) {
    if (underruns > 0) {
      return this.#grow('grew after running dry');
    }
    if (!active) {
      return { changed: false, reason: 'idle', target: this.target };
    }
    if (lowWater !== null && lowWater < this.dangerSamples) {
      return this.#grow('grew before running dry');
    }
    this.calmSeconds++;
    const readyToShrink =
      this.calmSeconds >= this.requiredCalmSeconds &&
      this.target > this.minSamples &&
      lowWater !== null &&
      lowWater >= this.shrinkSamples + this.cushionSamples;
    if (!readyToShrink) {
      return { changed: false, reason: 'holding', target: this.target };
    }
    if (this.shrankLast) {
      this.requiredCalmSeconds = Math.max(this.baseCalmSeconds, Math.floor(this.requiredCalmSeconds / 2));
    }
    this.target = Math.max(this.minSamples, this.target - this.shrinkSamples);
    this.calmSeconds = 0;
    this.shrankLast = true;
    return { changed: true, reason: 'trimmed after a steady stretch', target: this.target };
  }

  #grow(reason) {
    if (this.shrankLast) {
      this.requiredCalmSeconds = Math.min(MAX_REQUIRED_CALM_SECONDS, this.requiredCalmSeconds * 2);
    }
    this.shrankLast = false;
    this.calmSeconds = 0;
    if (this.target >= this.maxSamples) {
      return { changed: false, reason, target: this.target };
    }
    this.target = Math.min(this.maxSamples, this.target + this.growSamples);
    return { changed: true, reason, target: this.target };
  }
}
