// Stub: utils.ts - Utility types
export type DeepImmutable<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepImmutable<T[P]> : T[P]
}
