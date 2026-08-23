/** Injectable clock so time-dependent domains (sessions, gravity decay) stay testable. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
    return this.t;
  }
  set(ms: number) {
    this.t = ms;
  }
}
