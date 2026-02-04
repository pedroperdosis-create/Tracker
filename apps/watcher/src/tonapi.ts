type LimiterOptions = {
  rps: number;
  burst: number;
  concurrency: number;
};

type LimiterState = {
  tokens: number;
  lastRefill: number;
  inflight: number;
  cooldownUntil: number;
  effectiveRps: number;
  consecutiveOk: number;
  consecutive429: number;
};

const jitter = () => Math.floor(50 + Math.random() * 100);

export class TonApiLimiter {
  private readonly baseRps: number;
  private readonly burst: number;
  private readonly concurrency: number;
  private readonly state: LimiterState;
  private lastLogAt = 0;

  constructor(options: LimiterOptions) {
    this.baseRps = Math.max(0.1, options.rps);
    this.burst = Math.max(1, options.burst);
    this.concurrency = Math.max(1, options.concurrency);
    const now = Date.now();
    this.state = {
      tokens: this.burst,
      lastRefill: now,
      inflight: 0,
      cooldownUntil: 0,
      effectiveRps: this.baseRps,
      consecutiveOk: 0,
      consecutive429: 0
    };
  }

  private refill() {
    const now = Date.now();
    const elapsedMs = now - this.state.lastRefill;
    if (elapsedMs <= 0) return;
    const refillAmount = (elapsedMs / 1000) * this.state.effectiveRps;
    this.state.tokens = Math.min(this.burst, this.state.tokens + refillAmount);
    this.state.lastRefill = now;
  }

  private async waitForSlot() {
    while (true) {
      this.refill();
      const now = Date.now();
      const cooldownActive = now < this.state.cooldownUntil;
      if (!cooldownActive && this.state.tokens >= 1 && this.state.inflight < this.concurrency) {
        this.state.tokens -= 1;
        this.state.inflight += 1;
        return;
      }
      const waitMs = cooldownActive ? this.state.cooldownUntil - now : 100;
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, waitMs) + jitter()));
    }
  }

  private release() {
    this.state.inflight = Math.max(0, this.state.inflight - 1);
  }

  markResponse(status: number) {
    if (status === 429) {
      this.state.consecutive429 += 1;
      this.state.consecutiveOk = 0;
      this.state.effectiveRps = Math.max(0.5, this.state.effectiveRps / 2);
      this.state.cooldownUntil = Date.now() + Math.min(30000, 2000 * this.state.consecutive429);
      return;
    }
    if (status >= 200 && status < 300) {
      this.state.consecutiveOk += 1;
      this.state.consecutive429 = 0;
      if (this.state.consecutiveOk % 10 === 0) {
        this.state.effectiveRps = Math.min(this.baseRps, this.state.effectiveRps + 0.5);
      }
    }
  }

  logIfNeeded(logger: { info: (data: Record<string, unknown>, msg: string) => void }) {
    const now = Date.now();
    if (now - this.lastLogAt < 15000) return;
    this.lastLogAt = now;
    logger.info(
      {
        effectiveRps: this.state.effectiveRps,
        tokens: this.state.tokens,
        inflight: this.state.inflight,
        cooldownActive: Date.now() < this.state.cooldownUntil,
        cooldownUntil: this.state.cooldownUntil,
        consecutive429: this.state.consecutive429
      },
      "tonapi limiter"
    );
  }

  snapshot() {
    return {
      effectiveRps: this.state.effectiveRps,
      inflight: this.state.inflight,
      cooldownActive: Date.now() < this.state.cooldownUntil
    };
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForSlot();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class TonApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
