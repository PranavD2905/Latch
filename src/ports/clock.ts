/**
 * The domain's only source of "now". No file under src/domain/ may call
 * Date.now() or `new Date()` directly — everything goes through here.
 * See docs/01-architecture.md §5.
 */
export interface Clock {
  now(): Date
}
