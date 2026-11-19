import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { menuSurfaceClass } from '@/components/ui/menu'
import { createPluginContext } from '@/contrib/plugin'
import { BACKDROP_AREA } from '@/sdk/areas'
import { setPluginBackdropsEnabled } from '@/store/plugin-backdrops'

import { BackdropLayer } from './backdrop-layer'

// A backdrop is scenery behind the app, so every surface that carries text has
// to stay readable over it: the field is thinned on purpose, but only because
// the shell behind it paints the app's dim, and raised content (dialog,
// popover, menu, composer) keeps its own fill. jsdom paints no stylesheet, so
// the shipped rules are read from styles.css — the same contract the layer
// satisfies at runtime by setting `data-hermes-plugin-backdrop` and
// `--plugin-backdrop-dim` on <html>.
const STYLES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

/** The `@layer base` block holding the plugin-backdrop rules. */
function backdropBlock(css: string): string {
  const anchor = css.indexOf(':root[data-hermes-plugin-backdrop] #root')
  expect(anchor, 'backdrop #root rule').toBeGreaterThan(-1)

  const open = css.indexOf('{', css.lastIndexOf('@layer base', anchor))
  let depth = 0

  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') {
      depth += 1
    } else if (css[index] === '}' && (depth -= 1) === 0) {
      return css.slice(open + 1, index)
    }
  }

  throw new Error('Unbalanced backdrop block in styles.css')
}

/** Selector → declarations for the flat rules of one CSS block. */
function rules(body: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  let index = 0

  while (index < body.length) {
    const open = body.indexOf('{', index)

    if (open === -1) {
      break
    }

    const close = body.indexOf('}', open)
    const selector = body.slice(index, open).replace(/\s+/g, ' ').trim()
    const declarations: Record<string, string> = {}

    for (const line of body.slice(open + 1, close).split(';')) {
      const colon = line.indexOf(':')

      if (colon > 0) {
        declarations[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
      }
    }

    for (const part of selector.split(',')) {
      out.set(part.trim(), declarations)
    }

    index = close + 1
  }

  return out
}

/** The leading percentage of a `color-mix` / custom property fill. */
function mixPercent(value: string | undefined): number {
  const match = value?.match(/(\d+)%/)

  expect(match, value).not.toBeNull()

  return Number(match![1])
}

const backdrop = rules(backdropBlock(STYLES))
const rule = (selector: string) => backdrop.get(selector) ?? {}

const disposers: Array<() => void> = []
const ctx = createPluginContext('backdrop-readability')

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  setPluginBackdropsEnabled(false)
})

describe('backdrop readability', () => {
  it('dims the app by at least 70% for any backdrop, however low its dimApp', () => {
    setPluginBackdropsEnabled(true)
    render(<BackdropLayer />)
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'washed',
          data: { dimApp: 0.2 },
          render: () => <div>bright scene</div>
        })
      )
    })

    expect(screen.getByText('bright scene')).toBeTruthy()

    const dim = document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')
    expect(Number.parseFloat(dim)).toBeGreaterThanOrEqual(70)

    // The field's transparency is only safe because the shell behind it paints
    // that number — one contract, two rules.
    expect(rule(':root[data-hermes-plugin-backdrop] [data-contrib-shell]')['background-color']).toContain(
      'var(--plugin-backdrop-dim'
    )
  })

  it('keeps the chat surface solid wherever it masks the scene', () => {
    const opaque = rule(':root[data-hermes-plugin-backdrop] [data-glass-opaque]')

    expect(opaque['--ui-chat-surface-background']).toBe('var(--ui-bg-chrome)')
    expect(opaque['--ui-editor-surface-background']).toBe('var(--ui-bg-chrome)')
    expect(opaque['--ui-sidebar-surface-background']).toBe('var(--ui-bg-sidebar)')

    // Raised cards sit over the field: near-opaque, never thinner than it.
    const raised = rule(':root[data-hermes-plugin-backdrop] [data-glass-raised]')

    expect(mixPercent(raised['--ui-chat-surface-background'])).toBeGreaterThanOrEqual(94)
    expect(mixPercent(raised['--ui-sidebar-surface-background'])).toBeGreaterThanOrEqual(94)
    expect(raised['--ui-editor-surface-background']).toBe('var(--ui-bg-chrome)')
  })

  it('never thins the raised-card tokens a dialog, popover or menu paints with', () => {
    for (const declarations of backdrop.values()) {
      for (const token of ['--ui-chat-bubble-background', '--ui-bg-elevated', '--ui-bg-popover']) {
        expect(declarations[token] ?? '', token).not.toContain('transparent')
      }
    }

    // Menus are a mix of the elevated card, not a window: 90% keeps text on a
    // solid box even before the app's dim lands behind it.
    expect(mixPercent(menuSurfaceClass)).toBeGreaterThanOrEqual(90)
  })

  it('keeps the composer solid — it is where typing is read, not a window', () => {
    // Outside a backdrop the composer wears an 80–88% mix (the field behind it
    // is opaque, so the mix reads as a card). Over a scene that mix lets
    // scenery through the box you type in, so the layer pins it to the card in
    // every state — !important, because the scrolled-up / dock-hover ladder
    // restates the mix at higher specificity.
    const fill = rule(":root[data-hermes-plugin-backdrop] [data-slot='composer-root']")['--composer-fill']

    expect(fill).toContain('var(--dt-card)')
    expect(fill).not.toContain('transparent')
  })
})
