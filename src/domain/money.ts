/**
 * Money is always integer paise. Never a float, never rupees.
 * `Paise` is a branded `number` — see docs/02-tech-stack.md §8 for why.
 */
export type Paise = number & { readonly __brand: 'Paise' }

export class InvalidMoneyError extends Error {
  constructor(value: number) {
    super(`Paise must be a non-negative integer, got ${value}`)
    this.name = 'InvalidMoneyError'
  }
}

/** The only way to produce a `Paise`. Validates integrality and non-negativity. */
export function toPaise(value: number): Paise {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidMoneyError(value)
  }
  return value as Paise
}

export const ZERO_PAISE: Paise = toPaise(0)

export function addPaise(a: Paise, b: Paise): Paise {
  return toPaise(a + b)
}

/** Subtracts b from a. Throws if the result would be negative — money amounts are never negative. */
export function subtractPaise(a: Paise, b: Paise): Paise {
  return toPaise(a - b)
}

export function multiplyPaise(a: Paise, factor: number): Paise {
  if (!Number.isInteger(factor) || factor < 0) {
    throw new InvalidMoneyError(factor)
  }
  return toPaise(a * factor)
}

/**
 * Retains `pct` percent of `amount`, floored, per docs/03-domain-model.md §2:
 * "retain = floor(deposit * pct / 100), refund is the remainder" — floor rather
 * than round so the two halves always sum to exactly the original amount.
 */
export function floorPercentageOf(amount: Paise, pct: number): Paise {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    throw new RangeError(`pct must be an integer 0-100, got ${pct}`)
  }
  return toPaise(Math.floor((amount * pct) / 100))
}

export function equalsPaise(a: Paise, b: Paise): boolean {
  return a === b
}

export function gtPaise(a: Paise, b: Paise): boolean {
  return a > b
}

export function gtePaise(a: Paise, b: Paise): boolean {
  return a >= b
}

export function ltPaise(a: Paise, b: Paise): boolean {
  return a < b
}

export function ltePaise(a: Paise, b: Paise): boolean {
  return a <= b
}
