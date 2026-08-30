import type { Clock } from '../../ports/clock.js'

/**
 * A Clock that never moves on its own. Tests set it to an exact instant
 * (e.g. "47h59m before the appointment") and assert against that boundary,
 * or advance() it explicitly to simulate time passing (e.g. hold TTL expiry).
 */
export class FrozenClock implements Clock {
  private current: Date

  constructor(initial: Date) {
    this.current = initial
  }

  now(): Date {
    return this.current
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }

  set(date: Date): void {
    this.current = date
  }
}
