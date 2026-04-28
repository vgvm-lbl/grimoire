'use strict'

/**
 * temporal.js — Temporal bounds for entities and relationships
 *
 * Adds validFrom / validUntil / assertionType to the KB schema.
 *
 * These fields describe WHEN an assertion is true in the world —
 * not when the file was created (that's git's job).
 *
 * ── Date format ───────────────────────────────────────────────────────────────
 * Accept any prefix of ISO 8601: "2020", "2020-06", "2020-06-15".
 * Stored as strings. Comparison is lexicographic, which works correctly
 * for ISO-formatted dates of the same granularity.
 *
 * ── Entity-level usage ────────────────────────────────────────────────────────
 * {
 *   "@type": "Project",
 *   "name": "Old Tool",
 *   "validFrom": "2018",
 *   "validUntil": "2022",
 *   "assertionType": "explicit"
 * }
 *
 * ── Relationship-level usage (rich edge format) ───────────────────────────────
 * {
 *   "relationships": {
 *     "works_on": [
 *       "project_current",
 *       { "id": "project_old", "validFrom": "2020-01", "validUntil": "2023-06" }
 *     ]
 *   }
 * }
 *
 * The plain string form ("project_current") is always valid — it means
 * "active with no known temporal bound". Both forms may appear in the same array.
 *
 * ── Assertion types ───────────────────────────────────────────────────────────
 * "explicit"  — user stated this directly
 * "inferred"  — system derived it (crawl, archaeologist, etc.)
 * Default: "explicit" when not specified.
 */

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Extract the target entity ID from a relationship target.
 * Works for both string IDs and rich { id, validFrom, ... } objects.
 */
function relTargetId(target) {
  if (typeof target === 'string') return target
  if (target && typeof target === 'object') return target.id || null
  return null
}

/**
 * Normalize a relationship target to a consistent object shape.
 * String form → { id } with no temporal bounds.
 */
function resolveTarget(target) {
  if (typeof target === 'string') {
    return { id: target, validFrom: null, validUntil: null, assertionType: 'explicit' }
  }
  if (target && typeof target === 'object' && target.id) {
    return {
      id:            target.id,
      validFrom:     target.validFrom  || null,
      validUntil:    target.validUntil || null,
      assertionType: target.assertionType || 'explicit',
    }
  }
  return null
}

/**
 * Check whether a relationship target (or entity) is active as of a given date.
 *
 * Rules:
 *   - No bounds → always active
 *   - validFrom only → active if asOf >= validFrom
 *   - validUntil only → active if asOf <= validUntil
 *   - Both → active if validFrom <= asOf <= validUntil
 *
 * Date comparison is lexicographic — works correctly for ISO dates
 * as long as both sides have the same granularity (year, month, or day).
 * Cross-granularity comparisons ("2020" vs "2020-06") also work because
 * "2020" < "2020-06" < "2020-07" lexicographically.
 *
 * @param {{ validFrom?: string, validUntil?: string } | string} target
 * @param {string} [asOf]  ISO date string (default: today YYYY-MM-DD)
 */
function isActive(target, asOf) {
  const t = typeof target === 'string' ? { validFrom: null, validUntil: null } : (target || {})
  const date = asOf || new Date().toISOString().slice(0, 10)

  if (t.validFrom  && date < t.validFrom)  return false
  // Cross-granularity: validUntil:"2022" should include "2022-12-31"
  // because "2022-12-31" > "2022" lexicographically but is still within year 2022.
  // A date is past the bound only if it's greater AND doesn't start with the bound prefix.
  if (t.validUntil && date > t.validUntil && !date.startsWith(t.validUntil)) return false
  return true
}

/**
 * Filter a relationship target array to those active as of a date.
 * Preserves original form (string or object) of active targets.
 */
function filterActive(targets, asOf) {
  if (!Array.isArray(targets)) return []
  return targets.filter(t => isActive(typeof t === 'string' ? {} : t, asOf))
}

/**
 * Collect all entity IDs from a relationship target array.
 * Handles mixed string/object arrays.
 */
function collectIds(targets) {
  if (!Array.isArray(targets)) return []
  return targets.map(relTargetId).filter(Boolean)
}

/**
 * Collect IDs of currently-active targets only.
 */
function collectActiveIds(targets, asOf) {
  return collectIds(filterActive(targets, asOf))
}

/**
 * Summarise temporal bounds as a human-readable string.
 * Returns empty string if no bounds are set.
 *
 * Examples:
 *   validFrom: "2020", validUntil: "2023"  →  "(2020–2023)"
 *   validFrom: "2020"                       →  "(from 2020)"
 *   validUntil: "2022"                      →  "(until 2022)"
 */
function fmtBounds(target) {
  const t = typeof target === 'string' ? {} : (target || {})
  if (t.validFrom && t.validUntil) return `(${t.validFrom}–${t.validUntil})`
  if (t.validFrom)                 return `(from ${t.validFrom})`
  if (t.validUntil)                return `(until ${t.validUntil})`
  return ''
}

module.exports = { relTargetId, resolveTarget, isActive, filterActive, collectIds, collectActiveIds, fmtBounds }
