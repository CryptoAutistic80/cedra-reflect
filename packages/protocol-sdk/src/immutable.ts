/**
 * Detach a public read result from its adapter-owned source and recursively
 * freeze every reachable record/array before it crosses the SDK boundary.
 * SDK read models deliberately contain only structured-cloneable values.
 */
export function detachedDeepFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value), new WeakSet<object>());
}

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}
