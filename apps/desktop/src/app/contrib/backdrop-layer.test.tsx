import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPluginContext } from '@/contrib/plugin'
import { registry } from '@/contrib/registry'
import { BACKDROP_AREA } from '@/sdk/areas'
import { setPluginBackdropsEnabled } from '@/store/plugin-backdrops'
import * as windows from '@/store/windows'

import { BackdropLayer } from './backdrop-layer'

const disposers: Array<() => void> = []
const ctx = createPluginContext('backdrop-test')

// The setting is off on a fresh store; these tests exercise a live backdrop, so
// they opt in and always leave it off again.
beforeEach(() => {
  setPluginBackdropsEnabled(true)
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  setPluginBackdropsEnabled(false)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

function dim() {
  return window.document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')
}

/** A controllable matchMedia where only the queries flipped on match. */
function stubQueries() {
  const active = new Set<string>()
  const listeners = new Map<string, Set<() => void>>()

  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return active.has(query)
    },
    addEventListener: (_: string, listener: () => void) => {
      const set = listeners.get(query) ?? new Set()
      set.add(listener)
      listeners.set(query, set)
    },
    removeEventListener: (_: string, listener: () => void) => {
      listeners.get(query)?.delete(listener)
    }
  }))

  return (query: string, on: boolean) => {
    if (on) {
      active.add(query)
    } else {
      active.delete(query)
    }

    listeners.get(query)?.forEach(listener => listener())
  }
}

describe('BackdropLayer', () => {
  it('selects a re-registered contribution and falls back when it is disposed', () => {
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'a', order: -100, render: () => <div>first A</div> }))
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'b', order: 100, render: () => <div>B</div> }))
    })
    expect(screen.getByText('B')).toBeTruthy()
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'a', order: -100, render: () => <div>new A</div> }))
    })
    expect(screen.getByText('new A')).toBeTruthy()
    expect(screen.queryByText('B')).toBeNull()
    act(() => disposers.pop()?.())
    expect(screen.getByText('B')).toBeTruthy()
  })

  it('mounts a real backdrop in a contained, click-through wrapper and restores the host on disposal', () => {
    vi.spyOn(windows, 'isMainWindow').mockReturnValue(true)
    const { container } = render(<BackdropLayer />)
    const bodyChildren = [...window.document.body.children]

    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'first',
          order: 100,
          render: () => <div>first</div>
        })
      )
    })
    // A real contribution, inside the host's own wrapper — not a portal.
    const layer = container.querySelector('[data-plugin-backdrop]') as HTMLElement
    expect(screen.getByText('first')).toBeTruthy()
    expect(layer.style.position).toBe('fixed')
    expect(layer.style.pointerEvents).toBe('none')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.hasAttribute('inert')).toBe(true)
    expect([...window.document.body.children]).toEqual(bodyChildren)
    // The layer only exists because this is the main window.
    expect(windows.isMainWindow).toHaveBeenCalled()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
    expect(dim()).toBe('85%')

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'second', order: -100, render: () => <div>second</div> }))
    })
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.getByText('second')).toBeTruthy()
    act(() => disposers.pop()?.())
    expect(screen.getByText('first')).toBeTruthy()
    act(() => disposers.pop()?.())
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    expect(dim()).toBe('')
  })

  it('clamps opacity to 0–1 and floors the shell opacity at 85%', () => {
    const { container } = render(<BackdropLayer />)
    const layer = () => container.querySelector('[data-plugin-backdrop]') as HTMLElement

    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'bounded',
          data: { opacity: 2, appOpacity: -1 },
          render: () => <div>scene</div>
        })
      )
    })
    expect(layer().style.opacity).toBe('1')
    expect(dim()).toBe('85%')

    // Below the floor a bright scene washes out secondary text, so it clamps.
    act(() => {
      disposers.push(
        ctx.register({ area: BACKDROP_AREA, id: 'bounded', data: { opacity: 0, appOpacity: 0.35 }, render: () => <div>b</div> })
      )
    })
    expect(layer().style.opacity).toBe('0')
    expect(dim()).toBe('85%')

    // A re-registration moves the shell opacity the CSS reads.
    act(() => {
      disposers.push(
        ctx.register({ area: BACKDROP_AREA, id: 'bounded', data: { opacity: 0.5, appOpacity: 1 }, render: () => <div>c</div> })
      )
    })
    expect(layer().style.opacity).toBe('0.5')
    expect(dim()).toBe('100%')

    // Non-finite values are not numbers to clamp: the defaults apply.
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'bounded',
          data: { opacity: Infinity, appOpacity: Number.NaN },
          render: () => <div>d</div>
        })
      )
    })
    expect(layer().style.opacity).toBe('1')
    expect(dim()).toBe('85%')
  })

  it('paints nothing for a registration until the setting is enabled', () => {
    setPluginBackdropsEnabled(false)
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })

    expect(screen.queryByText('scene')).toBeNull()
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    expect(dim()).toBe('')

    // The registration was never consumed — enabling the setting is all it
    // takes for the same backdrop to appear.
    act(() => setPluginBackdropsEnabled(true))
    expect(screen.getByText('scene')).toBeTruthy()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })

  it('restores a valid backdrop when the Appearance setting is toggled off and back on', () => {
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })
    expect(screen.getByText('scene')).toBeTruthy()

    act(() => setPluginBackdropsEnabled(false))
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(screen.queryByText('scene')).toBeNull()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)

    act(() => setPluginBackdropsEnabled(true))
    expect(screen.getByText('scene')).toBeTruthy()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })

  it('contains a throwing when() and never evaluates it while the setting is off', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const when = vi.fn(() => {
      throw new Error('predicate')
    })

    setPluginBackdropsEnabled(false)
    render(
      <>
        <div>app</div>
        <BackdropLayer />
      </>
    )
    const throwing = ctx.register({ area: BACKDROP_AREA, id: 'throws', when, render: () => <div>scene</div> })
    act(() => disposers.push(throwing))

    // Disabled: the area is never read, so the predicate never runs.
    expect(when).not.toHaveBeenCalled()
    expect(screen.getByText('app')).toBeTruthy()

    act(() => setPluginBackdropsEnabled(true))
    expect(screen.getByText('app')).toBeTruthy()
    expect(screen.queryByText('scene')).toBeNull()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)

    // Dropping the poison lets a fresh registration paint again.
    act(() => throwing())
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'healthy', render: () => <div>scene</div> }))
    })
    expect(screen.getByText('scene')).toBeTruthy()
  })

  it('keeps a backdrop transparent when the browser ignores the reduced-transparency query', () => {
    // An engine that predates the feature: matchMedia resolves, nothing matches.
    // The root attribute is the CSS gate's only input, so the surface rules must
    // still apply — the media query can never be the second source of truth.
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }))
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })
    expect(screen.getByText('scene')).toBeTruthy()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })

  it('keeps a backdrop transparent when matchMedia is missing entirely', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })
    expect(screen.getByText('scene')).toBeTruthy()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })

  it('honors the setting and contains a failing contribution', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setPluginBackdropsEnabled(false)
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'broken',
          render: () => {
            throw new Error('broken')
          }
        })
      )
    })
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    act(() => setPluginBackdropsEnabled(true))
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
  })

  it.each(['?win=secondary', '?win=hud', '?win=browser', '?watch=1', '?peer=1'])(
    'does not mount in %s',
    async search => {
      window.history.replaceState({}, '', `/${search}`)
      vi.resetModules()
      const freshWindows = await import('@/store/windows')
      vi.spyOn(windows, 'isMainWindow').mockReturnValue(freshWindows.isMainWindow())
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'window', render: () => <div>scene</div> }))
      render(<BackdropLayer />)
      expect(screen.queryByText('scene')).toBeNull()
      expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    }
  )

  it.each([
    '(prefers-reduced-transparency: reduce)',
    '(prefers-reduced-motion: reduce)',
    '(forced-colors: active)',
    '(prefers-contrast: more)'
  ])('unmounts under %s alone and restores on reversal', query => {
    const setQuery = stubQueries()
    const unmount = vi.fn()

    function Scene() {
      useEffect(() => unmount, [])

      return <div>scene</div>
    }

    disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'reduced', render: Scene }))
    render(<BackdropLayer />)
    expect(screen.getByText('scene')).toBeTruthy()

    act(() => setQuery(query, true))
    expect(screen.queryByText('scene')).toBeNull()
    expect(unmount).toHaveBeenCalledOnce()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)

    act(() => setQuery(query, false))
    expect(screen.getByText('scene')).toBeTruthy()
  })

  it('returns only when none of several reduction preferences applies', () => {
    const setQuery = stubQueries()

    disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'stacked', render: () => <div>scene</div> }))
    render(<BackdropLayer />)

    act(() => setQuery('(prefers-contrast: more)', true))
    act(() => setQuery('(forced-colors: active)', true))
    expect(screen.queryByText('scene')).toBeNull()

    act(() => setQuery('(prefers-contrast: more)', false))
    expect(screen.queryByText('scene')).toBeNull()

    act(() => setQuery('(forced-colors: active)', false))
    expect(screen.getByText('scene')).toBeTruthy()
  })

  it('skips a newer entry whose render is not a function', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'valid', render: () => <div>valid</div> }))
    })
    act(() => {
      // Only an untyped (JS) plugin can register this; the host skips it and
      // keeps the previous valid backdrop on screen.
      disposers.push(registry.register({ area: BACKDROP_AREA, id: 'bad', render: 'nope' as never }))
    })
    expect(screen.getByText('valid')).toBeTruthy()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })

  it('falls back to an older backdrop when the newest is disabled or its when() says no', () => {
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'older', render: () => <div>older</div> }))
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'off', enabled: false, render: () => <div>off</div> }))
    })
    expect(screen.getByText('older')).toBeTruthy()

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'gated', when: () => false, render: () => <div>gated</div> }))
    })
    expect(screen.getByText('older')).toBeTruthy()
  })

  it('cleans the host attributes when the winning backdrop is replaced by a filtered one', () => {
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)

    // Same id re-registered behind a filter: the layer has nothing to paint.
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', enabled: false, render: () => <div>hidden</div> }))
    })
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    expect(dim()).toBe('')
  })

  it('type-checks a backdrop contribution at the call site', () => {
    // Never invoked: the body is a `tsc` assertion, proven by the directives
    // below turning into "unused @ts-expect-error" errors if the typing widens.
    const backdropCallSite = () => {
      // @ts-expect-error a backdrop's `data` is the closed { opacity?, appOpacity? } payload.
      ctx.register({ area: BACKDROP_AREA, id: 'bad-data', data: { bloom: 1 }, render: () => null })
      // @ts-expect-error a backdrop must provide `render`.
      ctx.register({ area: BACKDROP_AREA, id: 'no-render' })
      // @ts-expect-error a batch entry is checked the same way `register` checks it.
      ctx.registerMany([{ area: BACKDROP_AREA, id: 'batch-no-render' }])
      // A well-formed batch still compiles.
      ctx.registerMany([{ area: BACKDROP_AREA, id: 'batch', render: () => null, data: { appOpacity: 0.9 } }])
    }

    expect(backdropCallSite).toBeTypeOf('function')
  })

  it('skips entries without render and recovers when the same id is replaced', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'valid', render: () => <div>valid</div> }))
    })
    act(() => {
      // A render-less backdrop can only arrive from an untyped/JS plugin (the
      // typed API requires `render`); the host still skips it.
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'missing', render: undefined as never }))
    })
    expect(screen.getByText('valid')).toBeTruthy()
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'broken',
          render: () => {
            throw new Error('broken')
          }
        })
      )
    })
    expect(screen.queryByText('valid')).toBeNull()
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'broken', render: () => <div>fixed</div> }))
    })
    expect(screen.getByText('fixed')).toBeTruthy()
  })

  it('cleans up after a child effect throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    function Broken() {
      useEffect(() => {
        throw new Error('effect')
      }, [])

      return null
    }

    // The app lives beside the layer: containment means a throwing scene takes
    // only the backdrop down. React reports commit-phase (effect) errors the
    // same way it reports render errors — through the nearest boundary's
    // getDerivedStateFromError — so the subtree unmounts, its layout-effect
    // cleanup strips the <html> attributes, and the fallback renders null.
    const { container } = render(
      <>
        <div>app</div>
        <BackdropLayer />
      </>
    )

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'effect', render: Broken }))
    })
    expect(screen.getByText('app')).toBeTruthy()
    expect(screen.queryByText('scene')).toBeNull()
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    expect(dim()).toBe('')
  })
})

// The boundary key is the reconciliation seam: it alone decides whether a
// re-registration resets the backdrop's error state, so it is asserted through
// the scene's own mount count — a remount means the boundary was replaced.
describe('BackdropLayer boundary key', () => {
  it('keeps the boundary across unrelated renders and resets it on re-registration', () => {
    const mounts = vi.fn()

    function Scene() {
      useEffect(() => {
        mounts()
      }, [])

      return <div>scene</div>
    }

    const { rerender } = render(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'bg', render: Scene }))
    })

    const mounted = mounts.mock.calls.length
    expect(mounted).toBeGreaterThan(0)

    // Unrelated host re-renders keep the registration — and its boundary — so
    // the scene is not remounted and does not lose its state.
    rerender(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )
    rerender(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )
    expect(mounts.mock.calls.length).toBe(mounted)

    // Re-registering the same id is a NEW registration: a new key, so the
    // boundary (and any error state it holds) is reset and the scene remounts.
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'bg', render: Scene }))
    })
    expect(mounts.mock.calls.length).toBeGreaterThan(mounted)
  })

  it('resets a failed backdrop when the same id is re-registered', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )

    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'bg',
          render: () => {
            throw new Error('broken')
          }
        })
      )
    })
    expect(screen.queryByText('fixed')).toBeNull()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'bg', render: () => <div>fixed</div> }))
    })
    expect(screen.getByText('fixed')).toBeTruthy()
    expect(window.document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })
})
