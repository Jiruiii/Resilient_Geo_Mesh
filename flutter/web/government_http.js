(function installGovernmentHttp(global) {
  'use strict';
  global.ResilientGeoHttp = Object.freeze({
    async request(method, url, headersJson, body) {
      const headers = JSON.parse(headersJson);
      const response = await global.fetch(url, {
        method,
        headers,
        ...(body ? { body } : {}),
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
      });
      return JSON.stringify({ status: response.status, body: await response.text() });
    },
  });
})(globalThis);
