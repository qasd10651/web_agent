// mock-zlib.js
export function gunzipSync() { throw new Error("Browser does not support gunzipSync"); }
export function gzipSync() { throw new Error("Browser does not support gzipSync"); }
export const constants = {};