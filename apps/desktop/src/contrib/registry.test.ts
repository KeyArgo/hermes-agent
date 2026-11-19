import { afterEach, describe, expect, it } from 'vitest'

import { registry } from './registry'

// Registrations are global (module-level registry); each test captures its
// own disposer and this undoes it, so tests don't bleed into each other.
let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
})

describe('registry.getArea', () => {
  it('returns the same array reference across repeated calls until the area mutates', () => {
    dispose = registry.register({ area: 'test.stability', id: 'a' })

    const first = registry.getArea('test.stability')
    const second = registry.getArea('test.stability')

    // Consumers (useContributions, and anything memoized on its result — see
    // useStatusbarContributions in panes.tsx) depend on this snapshot cache
    // for referential stability. If getArea ever started returning a fresh
    // array per call, every memo keyed on it would recompute every render,
    // silently reintroducing bugs like #91603 with no failing test to catch it.
    expect(second).toBe(first)

    dispose()
    dispose = registry.register({ area: 'test.stability', id: 'b' })

    // A real mutation of the area IS expected to invalidate the snapshot.
    expect(registry.getArea('test.stability')).not.toBe(first)
  })
})

describe('registry disposal', () => {
  it('a stale disposer cannot remove a re-registration of the same id', () => {
    const stale = registry.register({ area: 'test.disposal', id: 'bg' })
    const replacement = { area: 'test.disposal', id: 'bg' }
    dispose = registry.register(replacement)

    // Disposal is by registration identity: the first registration was
    // replaced, so its disposer must leave the replacement in place.
    stale()
    expect(registry.getArea('test.disposal')).toEqual([replacement])

    // The replacement's own disposer still removes it.
    dispose()
    dispose = undefined
    expect(registry.getArea('test.disposal')).toEqual([])
  })
})
