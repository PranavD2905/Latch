import { describe, expect, it } from 'vitest'
import {
  addPaise,
  equalsPaise,
  floorPercentageOf,
  gtPaise,
  InvalidMoneyError,
  ltePaise,
  subtractPaise,
  toPaise,
  ZERO_PAISE,
  type Paise,
} from './money.js'

describe('toPaise', () => {
  it('accepts a non-negative integer', () => {
    expect(toPaise(80000)).toBe(80000)
  })

  it('rejects a non-integer amount', () => {
    expect(() => toPaise(80000.5)).toThrow(InvalidMoneyError)
  })

  it('rejects a negative amount', () => {
    expect(() => toPaise(-100)).toThrow(InvalidMoneyError)
  })

  it('does not allow a raw number where Paise is expected', () => {
    // The entire point of the brand: this must fail to compile, not just at runtime.
    // If this line ever compiles cleanly, the brand has silently stopped doing its job.
    // @ts-expect-error — a raw number is not assignable to Paise without going through toPaise()
    const notPaise: Paise = 80000
    void notPaise
  })
})

describe('arithmetic', () => {
  it('adds two amounts', () => {
    expect(addPaise(toPaise(30000), toPaise(20000))).toBe(50000)
  })

  it('subtracts within bounds', () => {
    expect(subtractPaise(toPaise(30000), toPaise(10000))).toBe(20000)
  })

  it('throws rather than go negative', () => {
    expect(() => subtractPaise(toPaise(100), toPaise(200))).toThrow(InvalidMoneyError)
  })

  it('compares amounts', () => {
    expect(gtPaise(toPaise(200), toPaise(100))).toBe(true)
    expect(equalsPaise(ZERO_PAISE, toPaise(0))).toBe(true)
    expect(ltePaise(toPaise(100), toPaise(100))).toBe(true)
  })
})

describe('floorPercentageOf', () => {
  it('floors so the two halves always sum to exactly the original amount', () => {
    // docs/03-domain-model.md §2 — ₹800 deposit? no, ladder applies to the ₹300 deposit
    // examples: 300 at 50% retained -> 150 retained, 150 refunded
    const deposit = toPaise(30000)
    const retained = floorPercentageOf(deposit, 50)
    const refunded = subtractPaise(deposit, retained)
    expect(retained).toBe(15000)
    expect(addPaise(retained, refunded)).toBe(deposit)
  })

  it('floors rather than rounds on an uneven split', () => {
    // 799 * 50 / 100 = 399.5 -> must floor to 399, never round to 400
    const amount = toPaise(799)
    expect(floorPercentageOf(amount, 50)).toBe(399)
  })

  it('0% retains nothing, 100% retains everything', () => {
    const amount = toPaise(40000)
    expect(floorPercentageOf(amount, 0)).toBe(0)
    expect(floorPercentageOf(amount, 100)).toBe(40000)
  })
})
