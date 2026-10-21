import type { JsonObject, JsonValue } from '../../types'
import { isObject } from '../transcript'

/** Readers for ACP fields kept as JsonValue; a missing or mistyped field reads as empty. */
export const obj = (value: JsonValue | undefined): JsonObject => (isObject(value) ? value : {})
export const list = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : [])
export const text = (value: JsonValue | undefined): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
export const json = (value: JsonValue | undefined): string => JSON.stringify(value ?? null, null, 2)
