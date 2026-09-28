export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Test clock. Time only moves when a test moves it. */
export class FakeClock implements Clock {
  #t: number;
  constructor(start = "2026-09-28T16:02:00Z") {
    this.#t = Date.parse(start);
  }
  now() {
    return new Date(this.#t);
  }
  advance(seconds: number) {
    this.#t += seconds * 1000;
  }
  advanceDays(days: number) {
    this.advance(days * 86400);
  }
}
