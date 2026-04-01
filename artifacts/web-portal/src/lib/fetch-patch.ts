const originalFetch = window.fetch;

window.fetch = async (...args) => {
  const [input, init = {}] = args;
  
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  
  const isRelativeApi = url.startsWith('/api');
  const isSameOriginApi = url.startsWith(window.location.origin + '/api');
  if (isRelativeApi || isSameOriginApi) {
    const headers = new Headers(init.headers);

    // @ts-expect-error - Telegram is injected by script
    const tgInitData = window.Telegram?.WebApp?.initData;
    const mockInitData = localStorage.getItem('mock_init_data');
    const sessionToken = localStorage.getItem('claimbase_session_token');
    
    if (tgInitData || mockInitData) {
      headers.set('X-Telegram-Init-Data', tgInitData || mockInitData!);
    } else if (sessionToken) {
      headers.set('Authorization', `Bearer ${sessionToken}`);
    }

    init.headers = headers;
  }
  
  return originalFetch(input, init);
};

export {};
