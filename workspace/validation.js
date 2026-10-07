'use strict';

const { createHash } = require('node:crypto');
const { check } = require('./errors');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function object(value, keys, label = 'input') {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INVALID_INPUT', `${label} must be an object`);
  check(Object.keys(value).every((key) => keys.includes(key)), 'INVALID_INPUT', `${label} contains unsupported fields`);
  return value;
}

function text(value, label, max = 1000, empty = false) {
  check(typeof value === 'string' && value.length <= max && !value.includes('\0') &&
    (empty || value.trim().length > 0), 'INVALID_INPUT', `${label} is invalid`);
  return value;
}

function uuid(value, label = 'id') {
  check(typeof value === 'string' && UUID.test(value), 'INVALID_INPUT', `${label} must be a lowercase UUID`);
  return value;
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', `${label} is invalid`);
  return value;
}

function choice(value, choices, label) {
  check(choices.includes(value), 'INVALID_INPUT', `${label} is invalid`);
  return value;
}

function boolean(value, label) {
  check(typeof value === 'boolean', 'INVALID_INPUT', `${label} must be boolean`);
  return value;
}

function instant(value, label) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  'INVALID_INPUT', `${label} must be a canonical UTC instant`);
  return value;
}

function date(value, label) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value,
  'INVALID_INPUT', `${label} must be a valid calendar date`);
  return value;
}

function timezone(value) {
  text(value, 'timezone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); }
  catch { check(false, 'INVALID_INPUT', 'timezone is invalid'); }
  return value;
}

function stableJson(value, maxBytes = 1024 * 1024) {
  let count = 0;
  function visit(item, depth) {
    check(depth <= 32 && ++count <= 50000, 'INVALID_INPUT', 'JSON exceeds structural limits');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') {
      check(Number.isFinite(item), 'INVALID_INPUT', 'JSON numbers must be finite');
      return item;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    check(item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item)),
      'INVALID_INPUT', 'Expected plain JSON data');
    const result = Object.create(null);
    for (const key of Object.keys(item).sort()) {
      check(!['__proto__', 'prototype', 'constructor'].includes(key), 'INVALID_INPUT', 'Unsafe JSON key');
      result[key] = visit(item[key], depth + 1);
    }
    return result;
  }
  const serialized = JSON.stringify(visit(value, 0));
  check(Buffer.byteLength(serialized) <= maxBytes, 'INVALID_INPUT', 'JSON exceeds byte limit');
  return serialized;
}

function json(value = {}, maxBytes = 65536) {
  return JSON.parse(stableJson(value, maxBytes));
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

module.exports = { object, text, uuid, integer, choice, boolean, instant, date, timezone, stableJson, json, hash };
