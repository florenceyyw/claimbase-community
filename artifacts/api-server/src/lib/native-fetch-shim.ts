const nativeFetch = globalThis.fetch;

const fetchWrapper = Object.assign(
  function fetch(url: string | URL | globalThis.Request, opts?: RequestInit): Promise<globalThis.Response> {
    return nativeFetch(url, opts);
  },
  {
    default: function fetch(url: string | URL | globalThis.Request, opts?: RequestInit): Promise<globalThis.Response> {
      return nativeFetch(url, opts);
    },
  }
);

export default fetchWrapper;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
