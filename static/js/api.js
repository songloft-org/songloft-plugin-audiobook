// API 请求层
const API_BASE = './';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function api(path, options, _retryCount) {
  const url = API_BASE + path.replace(/^\//, '');
  const init = options || {};
  init.headers = init.headers || {};
  try {
    const authData = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
    if (authData.accessToken) {
      init.headers['Authorization'] = 'Bearer ' + authData.accessToken;
    }
  } catch (e) {}
  const retries = _retryCount === undefined ? 3 : _retryCount;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 401) {
      throw new Error('认证过期，请刷新页面或重新登录');
    }
    if (res.status === 500 || res.status === 503) {
      if (attempt < retries) {
        await delay(500);
        continue;
      }
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '请求失败');
    return json.data;
  }
}
