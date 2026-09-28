/**
 * API 封装 — 统一请求、鉴权头、错误处理
 */
(function (global) {
  const API = {
    token: localStorage.getItem('ht_token') || '',
    // 管理者令牌：刻意存 sessionStorage 而非 localStorage —— 关掉标签页即失效
    adminToken: sessionStorage.getItem('ht_admin_token') || '',

    setToken(t) {
      this.token = t || '';
      if (t) localStorage.setItem('ht_token', t);
      else localStorage.removeItem('ht_token');
    },

    setAdminToken(t) {
      this.adminToken = t || '';
      if (t) sessionStorage.setItem('ht_admin_token', t);
      else sessionStorage.removeItem('ht_admin_token');
    },

    async request(method, url, body, isForm, extraHeaders) {
      const headers = {};
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
      if (!isForm) headers['Content-Type'] = 'application/json';
      if (extraHeaders) Object.assign(headers, extraHeaders);

      const opts = { method, headers };
      if (body) opts.body = isForm ? body : JSON.stringify(body);

      const res = await fetch(url, opts);
      let data = null;
      try { data = await res.json(); } catch (e) { data = {}; }

      // 管理者接口的失败响应带 admin:true：失效的是「管理口令」而不是登录态。
      // 这种情况绝不能走下面的清 token 逻辑，否则只是口令输错就会把用户踢下线。
      if (data && data.admin === true) {
        if (res.status !== 200) {
          if (res.status === 401 || res.status === 403) this.setAdminToken('');
          const err = new Error(data.message || '管理者身份已失效，请重新验证');
          err.admin = true;
          throw err;
        }
      }

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

    // 管理者接口统一入口：自动带 Authorization（用户登录态）+ X-Admin-Token（管理令牌）
    adminRequest(method, url, body, isForm) {
      return this.request(method, url, body, isForm, this.adminToken ? { 'X-Admin-Token': this.adminToken } : {});
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

    // 封面图上传：原始字节流直传（非 multipart），服务端按魔数校验格式
    async uploadCover(file) {
      const headers = {};
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
      if (file && file.type) headers['Content-Type'] = file.type;
      const res = await fetch('/api/soup-cover', { method: 'POST', headers, body: file });
      let data = null;
      try { data = await res.json(); } catch (e) { data = {}; }
      if (res.status === 401) {
        this.setToken('');
        if (typeof global.onUnauthorized === 'function') global.onUnauthorized();
        throw new Error(data.message || '未登录或登录已过期');
      }
      if (!res.ok) throw new Error(data.message || '封面上传失败（' + res.status + '）');
      return data;
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

    // ==================== 管理者（知识库） ====================
    // 口令校验：通过后拿到 2 小时有效的管理令牌，存 sessionStorage
    adminLogin(password) {
      return this.request('POST', '/api/admin/login', { password });
    },
    adminLogout() {
      this.setAdminToken('');
    },
    // 知识库概览（同时用于「令牌是否仍然有效」的探活）
    adminStats() {
      return this.adminRequest('GET', '/api/admin/kb/stats');
    },
    adminListDocuments(page, pageSize) {
      return this.adminRequest(
        'GET',
        '/api/admin/kb/documents?page=' + encodeURIComponent(page || 1) +
        '&pageSize=' + encodeURIComponent(pageSize || 20)
      );
    },
    // 批量上传：一次请求带多个文件（服务端支持单次最多 50 个）
    adminUploadKnowledge(files) {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      return this.adminRequest('POST', '/api/admin/kb/upload', fd, true);
    },
    adminSearchKnowledge(payload) {
      return this.adminRequest('POST', '/api/admin/kb/search', payload);
    },
    adminDeleteDocument(id) {
      return this.adminRequest('DELETE', '/api/admin/kb/documents/' + encodeURIComponent(id));
    },
    adminResetKnowledge(confirmText) {
      return this.adminRequest('POST', '/api/admin/kb/reset', { confirm: confirmText });
    },
  };

  global.API = API;
})(window);
