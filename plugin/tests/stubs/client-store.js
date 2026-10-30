/** Test-only snapshot store: SettingsFormModel only needs getSnapshot/subscribe/set. */

export function createSnapshotStore(init) {
  let state = init
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    getSnapshot: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(next) {
      state = next
      notify()
    },
    update(mutator) {
      const draft = structuredClone(state)
      mutator(draft)
      state = draft
      notify()
    },
  }
}

export function notifySubscribers(listeners, _label, ...args) {
  for (const listener of [...listeners]) listener(...args)
}

export function shallowEqual(left, right) {
  return Object.is(left, right)
}

export function defineStore() {
  throw new Error('defineStore is unused by the eval-card tests')
}
