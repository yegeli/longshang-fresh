// WeChat's JavaScriptCore version depends on the host app. Install only the
// built-ins used by this package when the host does not already provide them.
// This file must run before the shared model and page definitions are loaded.
if (typeof Object.fromEntries !== 'function') {
  Object.defineProperty(Object, 'fromEntries', { configurable: true, writable: true, value(entries) {
    const result = {};
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' && typeof entry !== 'function') throw new TypeError('Entry must be an object.');
      const key = typeof entry[0] === 'symbol' ? entry[0] : String(entry[0]);
      Object.defineProperty(result, key, { value: entry[1], enumerable: true, configurable: true, writable: true });
    }
    return result;
  } });
}
if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', { configurable: true, writable: true, value(target, key) {
    if (target === null || target === undefined) throw new TypeError('Object is required.');
    return Object.prototype.hasOwnProperty.call(target, key);
  } });
}
if (typeof Array.prototype.flatMap !== 'function') {
  Object.defineProperty(Array.prototype, 'flatMap', { configurable: true, writable: true, value(callback, receiver) {
    if (this === null || this === undefined || typeof callback !== 'function') throw new TypeError('Array and callback are required.');
    const source = Object(this), result = [], length = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(source.length) || 0)));
    for (let index = 0; index < length; index++) {
      if (!(index in source)) continue;
      const mapped = callback.call(receiver, source[index], index, source);
      if (Array.isArray(mapped)) {
        for (let nested = 0; nested < mapped.length; nested++) if (nested in mapped) result.push(mapped[nested]);
      } else result.push(mapped);
    }
    return result;
  } });
}
