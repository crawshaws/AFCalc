/// <reference path="types.app.js" />

/** @param {string} sel */
const $ = (sel) => document.querySelector(sel);

/** @param {string} sel */
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeId(prefix) {
  // Good enough for local-only IDs.
  const rand = Math.random().toString(16).slice(2);
  return `${prefix}_${Date.now().toString(16)}_${rand}`;
}

function toNumberOrNull(v) {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(v) {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}


function compareByName(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}


function filterByName(list, q) {
  const s = q.trim().toLowerCase();
  if (!s) return list;
  return list.filter((x) => String(x.name ?? "").toLowerCase().includes(s));
}



/**
 * Parse a time string in format like "2m30s", "1m", "45s", or plain "120" (seconds)
 * Returns the total time in seconds, or null if invalid.
 */
function parseTimeString(str) {
  if (!str) return null;
  str = String(str).trim().toLowerCase();

  // Try plain number first
  const plainNum = parseFloat(str);
  if (!isNaN(plainNum) && /^\d+\.?\d*$/.test(str)) {
    return plainNum > 0 ? plainNum : null;
  }

  // Parse format like "2m30s", "1m", "45s"
  let totalSeconds = 0;

  // Match minutes
  const minutesMatch = str.match(/(\d+\.?\d*)m/);
  if (minutesMatch) {
    totalSeconds += parseFloat(minutesMatch[1]) * 60;
  }

  // Match seconds
  const secondsMatch = str.match(/(\d+\.?\d*)s/);
  if (secondsMatch) {
    totalSeconds += parseFloat(secondsMatch[1]);
  }

  // If we found neither minutes nor seconds in the format, it's invalid
  if (!minutesMatch && !secondsMatch) {
    return null;
  }

  return totalSeconds > 0 ? totalSeconds : null;
}

/**
 * Format seconds into a readable time string like "2m30s", "1m", "45s", or just "120s"
 */
function formatTimeString(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";

  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (minutes > 0 && secs > 0) {
    // Remove trailing zeros after decimal point
    const secsStr = secs % 1 === 0 ? secs : secs.toFixed(2).replace(/\.?0+$/, '');
    return `${minutes}m${secsStr}s`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  } else {
    const secsStr = secs % 1 === 0 ? secs : secs.toFixed(2).replace(/\.?0+$/, '');
    return `${secsStr}s`;
  }
}

/**
 * Format minutes to readable time string
 * @param {number} minutes - Time in minutes
 * @returns {string} Formatted time (e.g., "2m 30s", "45s")
 */
function formatTimeMinutes(minutes) {
  if (!minutes || !isFinite(minutes)) return "—";

  const totalSeconds = Math.round(minutes * 60);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;

  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Format copper amount into gold/silver/copper display
 * @param {number} copper - Amount in copper
 * @returns {string} Formatted string like "1g 50s 500c"
 */
function formatCoins(copper) {
  if (copper === 0) return "0c";

  const gold = Math.floor(copper / 100000); // 100 silver * 1000 copper
  const remainingAfterGold = copper % 100000;
  const silver = Math.floor(remainingAfterGold / 1000);
  const remainingCopper = Math.floor(remainingAfterGold % 1000);

  const parts = [];
  if (gold > 0) parts.push(`${gold}g`);
  if (silver > 0) parts.push(`${silver}s`);
  if (remainingCopper > 0 || parts.length === 0) parts.push(`${remainingCopper}c`);

  return parts.join(' ');
}