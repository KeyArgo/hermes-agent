import { afterEach, describe, expect, it } from 'vitest'

import { createDragGhost } from './drag-ghost'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('createDragGhost', () => {
  it('masks the app behind the chip under a plugin backdrop', () => {
    // The chip is appended to <body>, outside every painted shell, and it paints
    // a field token the backdrop clears — so it declares the fill itself.
    const ghost = createDragGhost('Research notes')

    const chip = document.body.firstElementChild as HTMLElement | null

    expect(chip?.textContent).toBe('Research notes')
    expect(chip?.hasAttribute('data-backdrop-opaque')).toBe(true)

    ghost.destroy()
    expect(document.body.firstElementChild).toBeNull()
  })
})
