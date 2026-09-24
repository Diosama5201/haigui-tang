/**
 * API 封装 — 统一请求、鉴权头、错误处理
 */
(function (global) {
  const API = {
    token: localStorage.getItem('ht_token') || '',

    setToken(t) {
      this.token = t || '';
      if (t) localStorage.setItem('ht_token', t);
      else localStorage.removeItem('ht_token');
    },

    async request(method, url, body, isForm) {
      const headers = {};
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
      if (!isForm) headers['Content-Type'] = 'application/json';

      const opts = { method, headers };
      if (body) opts.body = isForm ? body : JSON.stringify(body);

      const res = await fetch(url, opts);
      let data = null;
      try { data = await res.json(); } catch (e) { data = {}; }

      if (res.status === 401) {
        // 未登录 / 登录过期
        this.setToken('');
        if (typeof global.onUnauthorized === 'function') global.onUnauthorized();
        throw new Error(data.message || '未登录或登录已过期');
      }
      if (!res.ok) {
        throw new Error(data.message || '请求失败（' + res.status + '）');
      }
      return data;
    },

    // 用户
    register(username, password) {
      return this.request('POST', '/api/register', { username, password });
    },
    login(username, password) {
      return this.request('POST', '/api/login', { username, password });
    },
    logout() {
      return this.request('POST', '/api/logout');
    },
    me() {
      return this.request('GET', '/api/me');
    },

    // 海龟汤（不传参数 = 全量，供 AI 选汤页；传 page/pageSize = 分页，供汤库页）
    listSoups(page, pageSize) {
      let url = '/api/soups';
      if (page) {
        url += '?page=' + encodeURIComponent(page);
        if (pageSize) url += '&pageSize=' + encodeURIComponent(pageSize);
      }
      return this.request('GET', url);
    },
    getSoup(id) {
      return this.request('GET', '/api/soups/' + id);
    },
    createSoup(payload) {
      return this.request('POST', '/api/soups', payload);
    },
    updateSoup(id, payload) {
      return this.request('PUT', '/api/soups/' + id, payload);
    },
    deleteSoup(id) {
      return this.request('DELETE', '/api/soups/' + id);
    },
    uploadFile(file) {
      const fd = new FormData();
      fd.append('file', file);
      return this.request('POST', '/api/upload', fd, true);
    },

    // AI 陪玩
    aiAsk(payload) {
      return this.request('POST', '/api/ai/ask', payload);
    },
    aiShorten(payload) {
      return this.request('POST', '/api/ai/shorten', payload);
    },

    // AI 陪玩存档（保存进度 / 继续游玩）
    aiSave(payload) {
      return this.request('POST', '/api/ai/save', payload);
    },
    aiSaves() {
      return this.request('GET', '/api/ai/saves');
    },
    aiGetSave(soupId) {
      return this.request('GET', '/api/ai/save/' + encodeURIComponent(soupId));
    },

    // 陪玩引擎设置（每用户：大模型 / 离线引擎）
    aiGetSettings() {
      return this.request('GET', '/api/ai/settings');
    },
    aiSaveSettings(payload) {
      return this.request('PUT', '/api/ai/settings', payload);
    },
    aiTestSettings(payload) {
      return this.request('POST', '/api/ai/settings/test', payload);
    },
  };

  global.API = API;
})(window);
