import type { Clock } from '../../ports/clock.js'

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
}
