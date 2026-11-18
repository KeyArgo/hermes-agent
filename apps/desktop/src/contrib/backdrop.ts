import type { Contribution } from './types'

let sequence = 0
const registrations = new WeakMap<Contribution, number>()

export function recordBackdropRegistration(contribution: Contribution): void {
  registrations.set(contribution, ++sequence)
}

export function latestBackdrop(items: readonly Contribution[]): Contribution | undefined {
  let latest: Contribution | undefined
  let latestSequence = -1

  for (const item of items) {
    const registered = registrations.get(item) ?? 0
    if (item.render && registered > latestSequence) {
      latest = item
      latestSequence = registered
    }
  }

  return latest
}
