import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './sheet'

afterEach(() => {
  cleanup()
  window.document.documentElement.removeAttribute('data-hermes-plugin-backdrop')
})

describe('SheetContent under a plugin backdrop', () => {
  it('masks the scene without changing how it looks under window glass', () => {
    // A sheet portals to <body>, outside the shell that paints the app dim, and
    // it paints a token the backdrop clears. `data-backdrop-opaque` fills it
    // there and leaves the glass-only rendering alone.
    window.document.documentElement.setAttribute('data-hermes-plugin-backdrop', '')
    render(
      <Sheet open>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Language</SheetTitle>
            <SheetDescription>Pick a language</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    )

    const sheet = window.document.querySelector('[data-slot="sheet-content"]')

    expect(sheet).toBeTruthy()
    expect(sheet?.hasAttribute('data-backdrop-opaque')).toBe(true)
    expect(sheet?.hasAttribute('data-glass-opaque')).toBe(false)
  })
})
