import { afterEach, describe, expect, it } from 'vitest'

import { createDragGhost } from './drag-ghost'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('createDragGhost', () => {
  it('keeps the chip a solid surface under window glass and plugin backdrops', () => {
    // The chip is appended to <body>, outside every painted shell, and it paints
    // with a field token both translucent modes clear on <html>. Without its own
    // opt-out the label would float on the desktop or the backdrop scene.
    // Contract: `[data-glass-opaque]` in styles.css.
    const ghost = createDragGhost('Research notes')

    const chip = document.body.firstElementChild as HTMLElement | null

    expect(chip?.textContent).toBe('Research notes')
    expect(chip?.hasAttribute('data-glass-opaque')).toBe(true)

    ghost.destroy()
    expect(document.body.firstElementChild).toBeNull()
  })
})
