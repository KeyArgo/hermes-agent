import { afterEach, describe, expect, it } from 'vitest'

import { BACKDROP_AREA } from '@/sdk/areas'

import { latestBackdrop } from './backdrop'
import { registry } from './registry'
import type { Contribution } from './types'

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
  it('a stale backdrop disposer cannot remove a re-registration of the same id', () => {
    const render = () => null
    const stale = registry.register({ area: BACKDROP_AREA, id: 'bg', render })
    const replacement = { area: BACKDROP_AREA, id: 'bg', render }
    dispose = registry.register(replacement)

    // Backdrops dispose by registration identity: the first registration was
    // replaced, so its disposer must leave the replacement in place.
    stale()
    expect(registry.getArea(BACKDROP_AREA)).toEqual([replacement])

    // The replacement's own disposer still removes it.
    dispose()
    dispose = undefined
    expect(registry.getArea(BACKDROP_AREA)).toEqual([])
  })

  it('a stale disposer cannot remove the same object registered twice', () => {
    const entry: Contribution = { area: BACKDROP_AREA, id: 'bg', render: () => null }
    const stale = registry.register(entry)
    dispose = registry.register(entry)

    // Each registration owns its own entry, so the first disposer has nothing
    // of its own left to remove.
    stale()
    expect(registry.getArea(BACKDROP_AREA)).toHaveLength(1)

    dispose()
    dispose = undefined
    expect(registry.getArea(BACKDROP_AREA)).toEqual([])
  })

  it('other areas still dispose by id: the original disposer closes a refreshed entry', () => {
    const first = registry.register({ area: 'test.disposal', id: 'tab' })
    registry.register({ area: 'test.disposal', id: 'tab' })

    first()
    expect(registry.getArea('test.disposal')).toEqual([])
  })
})

describe('backdrop registrations', () => {
  it('lets the newest backdrop win whatever path registered it', () => {
    const render = () => null
    const first = registry.register({ area: BACKDROP_AREA, id: 'plugin:first', render })
    // A raw registration, the path <Contribute> takes, registered later.
    const second = registry.register({ area: BACKDROP_AREA, id: 'contribute:second', render })

    dispose = () => {
      second()
      first()
    }

    expect(latestBackdrop(registry.getArea(BACKDROP_AREA))?.id).toBe('contribute:second')
  })

  it('skips an entry whose render is not a function', () => {
    const first = registry.register({ area: BACKDROP_AREA, id: 'plugin:valid', render: () => null })
    const second = registry.register({ area: BACKDROP_AREA, id: 'plugin:bad', render: 'nope' as never })

    dispose = () => {
      second()
      first()
    }

    expect(latestBackdrop(registry.getArea(BACKDROP_AREA))?.id).toBe('plugin:valid')
  })
})
