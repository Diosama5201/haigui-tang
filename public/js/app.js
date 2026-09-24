/**
 * 海龟汤主站逻辑 — 路由 + 海龟汤库 + 添加海龟汤 + 预览弹窗
 */
(function () {
  const main = document.getElementById('mainContent');
  let currentUser = null; // 当前登录用户 { uid, username }

  // ==================== 工具 ====================
  function toast(msg, type) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show ' + (type || 'ok');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  // 圆角方框样式的弹窗（替代原生 alert，放缓弹出速度）
  function showDialog(opts) {
    return new Promise((resolve) => {
      const { title, message, confirmText, cancelText, showCancel, onConfirm } = opts || {};
      // 移除已存在的弹窗
      const old = document.querySelector('.custom-dialog-mask');
      if (old) old.remove();

      const mask = document.createElement('div');
      mask.className = 'custom-dialog-mask';
      mask.innerHTML = `
        <div class="custom-dialog">
          ${title ? `<div class="custom-dialog-title">${escapeHTML(title)}</div>` : ''}
          <div class="custom-dialog-body">${message != null ? escapeHTML(message) : ''}</div>
          <div class="custom-dialog-actions">
            ${showCancel ? '<button class="btn btn-ghost" data-act="cancel">' + (cancelText || '取消') + '</button>' : ''}
            <button class="btn btn-primary" data-act="confirm">${confirmText || '确定'}</button>
          </div>
        </div>
      `;
      document.body.appendChild(mask);

      const close = (result) => {
        mask.classList.add('dialog-hide');
        setTimeout(() => mask.remove(), 180);
        resolve(result);
      };

      mask.addEventListener('click', (e) => {
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'confirm') close(true);
        else if (act === 'cancel') close(false);
      });

      // 放缓出现：加淡入动画
      requestAnimationFrame(() => mask.classList.add('dialog-show'));
    });
  }

  // 新样例：圆角方框 alert（放缓弹出）
  function niceAlert(message) {
    return showDialog({ title: '提示', message, confirmText: '知道了' });
  }

  function starsHTML(n) {
    let s = '';
    for (let i = 1; i <= 5; i++) {
      s += `<span class="star${i <= n ? '' : ' off'}">★</span>`;
    }
    return `<span class="stars">${s}</span>`;
  }

  function typeTag(type) {
    const cls = type === '红汤' ? 'tag-type-red' : 'tag-type-clear';
    return `<span class="tag ${cls}">${type}</span>`;
  }

  function styleTag(style) {
    return `<span class="tag tag-style">${style || '本格'}</span>`;
  }

  // 未登录统一跳转登录页
  window.onUnauthorized = function () {
    if (location.pathname.endsWith('app.html')) {
      location.href = '/index.html';
    }
  };

  // ==================== 鉴权检查 ====================
  async function checkAuth() {
    if (!API.token) {
      location.href = '/index.html';
      return null;
    }
    try {
      const data = await API.me();
      currentUser = data.data;
      document.getElementById('userName').textContent = data.data.username;
      return data.data;
    } catch (e) {
      // 401 已由 api.js 处理跳转
      return null;
    }
  }

  // ==================== 路由 ====================
  const routes = {
    library: renderLibrary,
    add: renderAdd,
    ai: renderAIConfig,
    settings: renderSettings,
  };

  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    return hash || 'library';
  }

  function navigate() {
    const route = parseRoute();
    // 编辑路由 #/edit/<id>
    const editMatch = route.match(/^edit\/([\w-]+)$/);
    // AI 选汤页 #/ai/play
    // AI 难度选择页 #/ai/play/<soupId>
    const aiPlayMatch = route.match(/^ai\/play(?:\/([\w-]+))?$/);

    let baseRoute = route;
    if (editMatch) baseRoute = 'edit';
    else if (route === 'ai' || aiPlayMatch) baseRoute = 'ai';

    document.querySelectorAll('.nav-item').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === baseRoute);
    });

    if (editMatch) {
      renderEditForm(editMatch[1]);
      return;
    }
    if (aiPlayMatch) {
      if (aiPlayMatch[1]) {
        renderAIDifficulty(aiPlayMatch[1]);
      } else {
        renderAIPlay();
      }
      return;
    }
    const handler = routes[route] || routes.library;
    handler();
  }

  window.addEventListener('hashchange', navigate);

  // 内部导航统一走 goto：hash 相同时浏览器不会触发 hashchange 事件，
  // 必须手动调用 navigate() 重渲染，否则页面卡在当前页（如"保存后退出"按钮卡住）
  function goto(hash) {
    if (location.hash === hash) navigate();
    else location.hash = hash;
  }

  // ==================== 海龟汤库（数字分页导航） ====================
  // 分页状态（模块级）：从修改页/预览返回时保留当前页
  let libraryPage = 1;
  let libraryPageSize = 10;

  async function renderLibrary() {
    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">海龟汤库</h1>
          <p class="page-desc">从上到下按添加时间列出所有海龟汤，点击「预览」查看汤面与汤底</p>
        </div>
        <div class="soup-list" id="soupList">
          <div class="empty"><p>加载中...</p></div>
        </div>
        <div class="pagination-wrap" id="paginationWrap"></div>
      </div>
    `;
    await loadLibraryPage();
  }

  async function loadLibraryPage() {
    const listEl = document.getElementById('soupList');
    const pgWrap = document.getElementById('paginationWrap');
    if (!listEl) return;
    try {
      const data = await API.listSoups(libraryPage, libraryPageSize);
      const d = data.data || {};
      const list = d.list || [];
      // 当前页超界（如最后一页记录被删光）时自动回退到末页
      if (d.totalPages && libraryPage > d.totalPages) {
        libraryPage = d.totalPages;
        return loadLibraryPage();
      }
      if (list.length === 0) {
        listEl.innerHTML = `
          <div class="empty">
            <img src="/img/turtle.svg" alt="空" />
            <p>还没有海龟汤，去「添加海龟汤」煮一碗吧 🐢</p>
          </div>`;
        if (pgWrap) pgWrap.innerHTML = '';
        return;
      }
      listEl.innerHTML = list.map((s, i) => {
        const isMine = currentUser && s.authorId === currentUser.uid;
        // 仅自己添加的汤显示红色「修改」「删除」按钮
        const editBtns = isMine ? `
          <button class="btn btn-danger" data-edit="${s.id}">修改</button>
          <button class="btn btn-danger" data-delete="${s.id}">删除</button>
        ` : '';
        return `
        <div class="soup-row">
          <div class="soup-index">${(d.page - 1) * d.pageSize + i + 1}</div>
          <div class="soup-main">
            <div class="soup-title">${escapeHTML(s.title)}</div>
            <div class="soup-tags">
              ${typeTag(s.type)}
              ${styleTag(s.style)}
              ${starsHTML(s.difficulty)}
              <span class="soup-author">by ${escapeHTML(s.author || '匿名')}</span>
            </div>
          </div>
          <div class="soup-actions">
            ${editBtns}
            <button class="btn btn-primary" data-preview="${s.id}">预览</button>
          </div>
        </div>
      `;
      }).join('');

      listEl.querySelectorAll('[data-preview]').forEach((btn) => {
        btn.addEventListener('click', () => openPreview(btn.dataset.preview));
      });
      listEl.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          goto('#/edit/' + btn.dataset.edit);
        });
      });
      listEl.querySelectorAll('[data-delete]').forEach((btn) => {
        btn.addEventListener('click', () => confirmDelete(btn.dataset.delete));
      });

      renderPagination(pgWrap, d.total, d.page, d.totalPages);
    } catch (e) {
      listEl.innerHTML =
        `<div class="empty"><p>加载失败：${escapeHTML(e.message)}</p></div>`;
    }
  }

  // ---------- 数字分页导航（共 X 条 · 每页 N 条 · 上一页 [1][2][…][末页] 下一页 · 跳至 X 页） ----------
  // 页码窗口：总页数 ≤7 全部显示；否则显示首末页 + 当前页前后各 1 页，其余用省略号
  function pageNumbers(current, totalPages) {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages = [1];
    const s = Math.max(2, current - 1);
    const e = Math.min(totalPages - 1, current + 1);
    if (s > 2) pages.push('ellipsis');
    for (let i = s; i <= e; i++) pages.push(i);
    if (e < totalPages - 1) pages.push('ellipsis');
    pages.push(totalPages);
    return pages;
  }

  function renderPagination(wrap, total, page, totalPages) {
    if (!wrap) return;
    if (!totalPages || totalPages <= 1) {
      wrap.innerHTML = '';
      return;
    }
    const nums = pageNumbers(page, totalPages).map((n) =>
      n === 'ellipsis'
        ? '<span class="pg-ellipsis">…</span>'
        : `<button class="pg-btn pg-num${n === page ? ' active' : ''}" data-pg="${n}">${n}</button>`
    ).join('');
    wrap.innerHTML = `
      <div class="pagination">
        <span class="pg-total">共 ${total} 条</span>
        <span class="pg-size">每页
          <select id="pgSize">
            ${[10, 20, 50].map((n) => `<option value="${n}"${n === libraryPageSize ? ' selected' : ''}>${n}</option>`).join('')}
          </select> 条
        </span>
        <button class="pg-btn" data-pg="prev"${page <= 1 ? ' disabled' : ''}>上一页</button>
        ${nums}
        <button class="pg-btn" data-pg="next"${page >= totalPages ? ' disabled' : ''}>下一页</button>
        <span class="pg-jump">跳至 <input type="number" id="pgJump" min="1" max="${totalPages}" value="${page}" /> 页</span>
      </div>
    `;
    wrap.querySelectorAll('[data-pg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-pg');
        if (v === 'prev') {
          if (libraryPage > 1) { libraryPage--; loadLibraryPage(); }
        } else if (v === 'next') {
          if (libraryPage < totalPages) { libraryPage++; loadLibraryPage(); }
        } else {
          const n = parseInt(v, 10);
          if (n !== libraryPage) { libraryPage = n; loadLibraryPage(); }
        }
      });
    });
    wrap.querySelector('#pgSize').addEventListener('change', (e) => {
      libraryPageSize = parseInt(e.target.value, 10) || 10;
      libraryPage = 1;
      loadLibraryPage();
    });
    const jump = wrap.querySelector('#pgJump');
    const doJump = () => {
      const n = parseInt(jump.value, 10);
      if (n >= 1 && n <= totalPages && n !== libraryPage) { libraryPage = n; loadLibraryPage(); }
    };
    jump.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJump(); });
  }

  // ==================== 预览弹窗 ====================
  async function openPreview(id) {
    const mask = document.getElementById('previewMask');
    try {
      const data = await API.getSoup(id);
      const s = data.data;
      document.getElementById('previewTitle').textContent = s.title;
      document.getElementById('previewMeta').innerHTML =
        `${typeTag(s.type)} ${styleTag(s.style)} ${starsHTML(s.difficulty)} <span class="soup-author">by ${escapeHTML(s.author || '匿名')}</span>`;
      document.getElementById('previewFace').textContent = s.face;
      document.getElementById('previewBottom').textContent = s.bottom;
      // 汤底默认隐藏，点击右下角按钮才显示
      document.getElementById('bottomSection').style.display = 'none';
      const revealBtn = document.getElementById('revealBottomBtn');
      revealBtn.style.display = 'inline-flex';
      revealBtn.textContent = '查看汤底';
      mask.style.display = 'flex';
    } catch (e) {
      toast('预览失败：' + e.message, 'err');
    }
  }

  function closePreview() {
    document.getElementById('previewMask').style.display = 'none';
  }

  // 点击「查看汤底」按钮后显示汤底
  document.getElementById('revealBottomBtn').addEventListener('click', () => {
    document.getElementById('bottomSection').style.display = 'block';
    document.getElementById('revealBottomBtn').style.display = 'none';
  });

  document.getElementById('previewClose').addEventListener('click', closePreview);
  document.getElementById('previewMask').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePreview();
  });

  // ==================== 添加海龟汤 ====================
  function renderAdd() {
    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">添加海龟汤</h1>
          <p class="page-desc">选择一种方式，把新的海龟汤加入汤库</p>
        </div>
        <div class="mode-cards">
          <div class="mode-card" id="modeWrite">
            <div class="mode-icon">✍️</div>
            <h3>自己写故事</h3>
            <p>亲自写下汤面与汤底</p>
            <button class="btn btn-primary">开始创作</button>
          </div>
          <div class="mode-card" id="modeUpload">
            <div class="mode-icon">📄</div>
            <h3>上传故事</h3>
            <p>上传 txt 文件自动解析</p>
            <button class="btn btn-primary">上传文件</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('modeWrite').addEventListener('click', () => renderWriteForm());
    document.getElementById('modeUpload').addEventListener('click', () => renderUploadForm());
  }

  // ---- 自己写故事 ----
  function renderWriteForm() {
    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">✍️ 自己写故事</h1>
          <p class="page-desc">左侧填写汤面（谜面），右侧填写汤底（答案）</p>
        </div>

        <div class="form-card">
          <h3>基本信息</h3>
          <div class="form-row">
            <div class="form-field">
              <label>汤名</label>
              <input type="text" id="wTitle" placeholder="给这碗汤起个名字" />
            </div>
            <div class="form-field">
              <label>作者署名</label>
              <input type="text" id="wAuthor" placeholder="可选，默认用你的用户名" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-field">
              <label>类型</label>
              <select id="wType">
                <option value="清汤">清汤</option>
                <option value="红汤">红汤</option>
              </select>
            </div>
            <div class="form-field">
              <label>风格</label>
              <select id="wStyle">
                <option value="本格">本格</option>
                <option value="变格">变格</option>
              </select>
            </div>
            <div class="form-field">
              <label>难度</label>
              <select id="wDiff">
                <option value="1">★ 1 星</option>
                <option value="2">★★ 2 星</option>
                <option value="3">★★★ 3 星</option>
                <option value="4">★★★★ 4 星</option>
                <option value="5">★★★★★ 5 星</option>
              </select>
            </div>
          </div>
        </div>

        <div class="dual-boxes">
          <div class="box-wrap">
            <label class="box-label face">🥣 汤面（谜面）</label>
            <textarea class="box-input face-glow" id="wFace" placeholder="在这里写下汤面..."></textarea>
          </div>
          <div class="box-wrap">
            <label class="box-label bottom">🔍 汤底（答案）</label>
            <textarea class="box-input bottom-glow" id="wBottom" placeholder="在这里写下汤底..."></textarea>
          </div>
        </div>

        <div style="margin-top:24px; display:flex; gap:12px; justify-content:flex-end;">
          <button class="btn btn-ghost" id="wBack">返回</button>
          <button class="btn btn-primary" id="wSubmit">提交入库</button>
        </div>
      </div>
    `;
    document.getElementById('wBack').addEventListener('click', renderAdd);
    document.getElementById('wSubmit').addEventListener('click', submitWrite);
  }

  async function submitWrite() {
    const title = document.getElementById('wTitle').value.trim();
    const face = document.getElementById('wFace').value.trim();
    const bottom = document.getElementById('wBottom').value.trim();
    const type = document.getElementById('wType').value;
    const style = document.getElementById('wStyle').value;
    const difficulty = Number(document.getElementById('wDiff').value);

    if (!title) { toast('请填写汤名', 'err'); return; }
    if (!face) { toast('请填写汤面', 'err'); return; }
    if (!bottom) { toast('请填写汤底', 'err'); return; }

    const btn = document.getElementById('wSubmit');
    btn.disabled = true;
    btn.textContent = '提交中...';
    try {
      await API.createSoup({ title, face, bottom, type, style, difficulty });
      toast('添加成功！');
      goto('#/library');
    } catch (e) {
      toast('添加失败：' + e.message, 'err');
      btn.disabled = false;
      btn.textContent = '提交入库';
    }
  }

  // ---- 上传故事 ----
  function renderUploadForm() {
    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">📄 上传故事</h1>
          <p class="page-desc">上传一个 .txt 文件，系统会自动解析出汤名、汤面与汤底</p>
        </div>

        <div class="form-card">
          <h3>文件格式说明</h3>
          <p style="font-size:14px;color:var(--ink-soft);line-height:2;">
            建议格式：<br />
            第一行写 <b>汤名</b><br />
            接下来写 <b>汤面</b><br />
            用一行「<b>汤底</b>」或「<b>====</b>」分隔后写 <b>汤底</b><br />
            例如：<br />
            <code style="background:var(--green-100);padding:2px 6px;border-radius:4px;">雪夜里的脚印<br />一个人在雪地里留下两排脚印，却没有往回走的痕迹。<br />汤底<br />他是被雪橇拉走的。</code>
          </p>
        </div>

        <div class="form-card">
          <div class="upload-btn-wrap">
            <label class="upload-btn">
              🐢 上传文件
              <input type="file" id="fileInput" accept=".txt,text/plain" />
            </label>
          </div>
          <p class="upload-hint" style="text-align:center;">仅支持 .txt 格式</p>

          <div class="upload-preview" id="uploadPreview" style="display:none">
            <h4>解析结果预览</h4>
            <div class="up-row"><b>文件名：</b><span id="upFileName"></span></div>
            <div class="up-row"><b>汤名：</b><span id="upTitle"></span></div>
            <div class="up-row"><b>汤面：</b><span id="upFace"></span></div>
            <div class="up-row"><b>汤底：</b><span id="upBottom"></span></div>
          </div>
        </div>

        <div class="form-card" id="uploadMetaCard" style="display:none">
          <h3>补充信息（解析后填写）</h3>
          <div class="form-row">
            <div class="form-field">
              <label>类型</label>
              <select id="uType">
                <option value="清汤">清汤</option>
                <option value="红汤">红汤</option>
              </select>
            </div>
            <div class="form-field">
              <label>风格</label>
              <select id="uStyle">
                <option value="本格">本格</option>
                <option value="变格">变格</option>
              </select>
            </div>
            <div class="form-field">
              <label>难度</label>
              <select id="uDiff">
                <option value="1">★ 1 星</option>
                <option value="2">★★ 2 星</option>
                <option value="3">★★★ 3 星</option>
                <option value="4">★★★★ 4 星</option>
                <option value="5">★★★★★ 5 星</option>
              </select>
            </div>
          </div>
          <div style="display:flex; gap:12px; justify-content:flex-end;">
            <button class="btn btn-ghost" id="uBack">返回</button>
            <button class="btn btn-primary" id="uSubmit">确认入库</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('uBack').addEventListener('click', renderAdd);
    document.getElementById('uSubmit').addEventListener('click', submitUpload);
    document.getElementById('fileInput').addEventListener('change', handleFile);
  }

  let uploadedData = null;

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.txt')) {
      toast('仅支持 .txt 格式的文件', 'err');
      return;
    }
    try {
      const data = await API.uploadFile(file);
      uploadedData = data.data;
      // 填充预览
      document.getElementById('uploadPreview').style.display = 'block';
      document.getElementById('upFileName').textContent = uploadedData.filename;
      document.getElementById('upTitle').textContent = uploadedData.title || '（未识别，可留空）';
      document.getElementById('upFace').textContent = uploadedData.face || '（空）';
      document.getElementById('upBottom').textContent = uploadedData.bottom || '（空）';
      document.getElementById('uploadMetaCard').style.display = 'block';
      toast(`文件解析成功，已自动存入向量库（${uploadedData.vectorIngested || 0} 条），请确认后入库`);
    } catch (err) {
      toast('上传失败：' + err.message, 'err');
    }
  }

  async function submitUpload() {
    if (!uploadedData) {
      toast('请先上传文件', 'err');
      return;
    }
    const title = uploadedData.title || '未命名海龟汤';
    const face = uploadedData.face;
    const bottom = uploadedData.bottom;
    if (!face || !bottom) {
      toast('解析出的汤面或汤底为空，请检查文件格式', 'err');
      return;
    }
    const type = document.getElementById('uType').value;
    const style = document.getElementById('uStyle').value;
    const difficulty = Number(document.getElementById('uDiff').value);

    const btn = document.getElementById('uSubmit');
    btn.disabled = true;
    btn.textContent = '入库中...';
    try {
      await API.createSoup({ title, face, bottom, type, style, difficulty });
      toast('添加成功！');
      goto('#/library');
    } catch (e) {
      toast('添加失败：' + e.message, 'err');
      btn.disabled = false;
      btn.textContent = '确认入库';
    }
  }

  // ==================== 修改海龟汤 ====================
  async function renderEditForm(id) {
    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">✏️ 修改海龟汤</h1>
          <p class="page-desc">修改后点击右下角「保存」，或「取消」放弃修改</p>
        </div>
        <div class="empty"><p>加载中...</p></div>
      </div>
    `;
    try {
      const data = await API.getSoup(id);
      const s = data.data;
      // 权限二次校验：只有作者本人能进入修改页
      if (!currentUser || s.authorId !== currentUser.uid) {
        main.innerHTML = `<div class="page"><div class="empty"><p>你无权修改这个海龟汤</p></div></div>`;
        return;
      }
      main.innerHTML = `
        <div class="page">
          <div class="page-head">
            <h1 class="page-title">✏️ 修改海龟汤</h1>
            <p class="page-desc">修改后点击右下角「保存」，或「取消」放弃修改</p>
          </div>

          <div class="form-card">
            <h3>基本信息</h3>
            <div class="form-row">
              <div class="form-field">
                <label>汤名</label>
                <input type="text" id="eTitle" value="${escapeHTML(s.title)}" />
              </div>
              <div class="form-field">
                <label>类型</label>
                <select id="eType">
                  <option value="清汤" ${s.type === '清汤' ? 'selected' : ''}>清汤</option>
                  <option value="红汤" ${s.type === '红汤' ? 'selected' : ''}>红汤</option>
                </select>
              </div>
              <div class="form-field">
                <label>风格</label>
                <select id="eStyle">
                  <option value="本格" ${s.style === '本格' ? 'selected' : ''}>本格</option>
                  <option value="变格" ${s.style === '变格' ? 'selected' : ''}>变格</option>
                </select>
              </div>
              <div class="form-field">
                <label>难度</label>
                <select id="eDiff">
                  ${[1,2,3,4,5].map(n => `<option value="${n}" ${s.difficulty === n ? 'selected' : ''}>${'★'.repeat(n)} ${n} 星</option>`).join('')}
                </select>
              </div>
            </div>
          </div>

          <div class="dual-boxes">
            <div class="box-wrap">
              <label class="box-label face">🥣 汤面（谜面）</label>
              <textarea class="box-input face-glow" id="eFace">${escapeHTML(s.face)}</textarea>
            </div>
            <div class="box-wrap">
              <label class="box-label bottom">🔍 汤底（答案）</label>
              <textarea class="box-input bottom-glow" id="eBottom">${escapeHTML(s.bottom)}</textarea>
            </div>
          </div>

          <div class="edit-actions">
            <button class="btn btn-ghost" id="eCancel">取消</button>
            <button class="btn btn-primary" id="eSave">保存</button>
          </div>
        </div>
      `;
      document.getElementById('eCancel').addEventListener('click', () => { goto('#/library'); });
      document.getElementById('eSave').addEventListener('click', () => submitEdit(id));
    } catch (e) {
      main.innerHTML = `<div class="page"><div class="empty"><p>加载失败：${escapeHTML(e.message)}</p></div></div>`;
    }
  }

  async function submitEdit(id) {
    const title = document.getElementById('eTitle').value.trim();
    const face = document.getElementById('eFace').value.trim();
    const bottom = document.getElementById('eBottom').value.trim();
    const type = document.getElementById('eType').value;
    const style = document.getElementById('eStyle').value;
    const difficulty = Number(document.getElementById('eDiff').value);

    if (!title) { toast('请填写汤名', 'err'); return; }
    if (!face) { toast('请填写汤面', 'err'); return; }
    if (!bottom) { toast('请填写汤底', 'err'); return; }

    const btn = document.getElementById('eSave');
    btn.disabled = true;
    btn.textContent = '保存中...';
    try {
      await API.updateSoup(id, { title, face, bottom, type, style, difficulty });
      await niceAlert('保存成功');
      goto('#/library');
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
      btn.disabled = false;
      btn.textContent = '保存';
    }
  }

  // ==================== 删除海龟汤 ====================
  async function confirmDelete(id) {
    const ok = await showDialog({
      title: '删除确认',
      message: '确定要删除这碗海龟汤吗？删除后无法恢复。',
      confirmText: '删除',
      cancelText: '取消',
      showCancel: true,
    });
    if (!ok) return;
    try {
      await API.deleteSoup(id);
      toast('删除成功！');
      renderLibrary();
    } catch (e) {
      toast('删除失败：' + e.message, 'err');
    }
  }

  // ==================== AI 陪玩 ====================
  // API 配置存储键
  const AI_CONFIG_KEY = 'ht_ai_config';

  function getAIConfig() {
    try {
      return JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }
  function saveAIConfig(cfg) {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(cfg));
  }
  function clearAIConfig() {
    localStorage.removeItem(AI_CONFIG_KEY);
  }

  // 难度定义
  const DIFFICULTIES = {
    easy: { label: '简单', questions: 35, timer: 0, shorten: false },
    master: { label: '汤达人', questions: 25, timer: 30 * 60, shorten: false },
    sherlock: { label: '福尔摩斯', questions: 15, timer: 10 * 60, shorten: true },
  };

  // 配置页：默认用内置离线引擎，可在此选择是否接入大模型
  function renderAIConfig() {
    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">🤖 AI 陪玩</h1>
          <p class="page-desc">默认使用内置离线引擎，无需任何配置即可游玩</p>
        </div>

        <div class="form-card">
          <h3>陪玩引擎</h3>
          <p style="font-size:14px;color:var(--ink-soft);margin-bottom:16px;">
            内置离线引擎开箱即用、零成本。接入大模型后，汤主的理解力会明显提升；<br />
            大模型调用失败时会自动退回离线引擎，不影响游戏。
          </p>
          <div style="display:flex; gap:12px; justify-content:flex-start;">
            <button class="btn btn-primary" id="aiGoOffline">用离线引擎直接开始</button>
            <button class="btn btn-ghost" id="aiGoConfig">接入大模型（可选）</button>
          </div>
        </div>

        <div class="form-card">
          <h3>玩法说明</h3>
          <p style="font-size:14px;color:var(--ink-soft);line-height:2;">
            1. AI 扮演「汤主」，你通过「是 / 否」问题逐步还原真相。<br />
            2. 只能问封闭式问题，AI 只会回答「是 / 否 / 无关紧要 / 是或不是」。<br />
            3. 三种难度：简单（35 问）、汤达人（25 问 + 30 分钟）、福尔摩斯（15 问 + 10 分钟 + 汤面删减）。<br />
            4. 推理进度达到 90% 以上、提问次数耗尽、倒计时归零，或主动结束时游戏结束。
          </p>
        </div>
      </div>
    `;
    document.getElementById('aiGoOffline').addEventListener('click', () => {
      goto('#/ai/play');
    });
    document.getElementById('aiGoConfig').addEventListener('click', () => {
      goto('#/settings');
    });
  }

  // 个人设置页：查看/修改 AI 接口配置（从左下角用户信息进入）
  async function renderSettings() {
    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">⚙️ 个人设置</h1>
          <p class="page-desc">管理账号信息与陪玩引擎</p>
        </div>

        <div class="form-card">
          <h3>账号信息</h3>
          <div class="form-field" style="margin-bottom:0;">
            <label>用户名</label>
            <input type="text" value="${escapeHTML(currentUser ? currentUser.username : '')}" disabled />
          </div>
        </div>

        <div class="form-card">
          <h3>陪玩引擎</h3>
          <p style="font-size:14px;color:var(--ink-soft);margin-bottom:16px;">
            默认使用内置离线引擎；开启「大模型主持」后优先调用大模型判断，失败自动退回离线引擎。
          </p>
          <div class="engine-switch-row">
            <div>
              <div class="engine-switch-title">大模型主持</div>
              <div class="engine-switch-desc">开启后优先调用大模型；关闭则使用内置离线引擎</div>
            </div>
            <button class="switch" id="stEngineSwitch" role="switch" aria-checked="false">
              <span class="switch-knob"></span>
            </button>
          </div>
          <div id="stLlmFields" style="display:none;margin-top:16px;">
            <div class="form-field" style="margin-bottom:16px;">
              <label>API Base URL</label>
              <input type="text" id="stBaseUrl" placeholder="例如 https://api.deepseek.com/v1" />
            </div>
            <div class="form-field" style="margin-bottom:16px;">
              <label>API Key</label>
              <input type="password" id="stApiKey" placeholder="输入你的 API Key（保存后不再明文回显）" autocomplete="off" />
            </div>
            <div class="form-field" style="margin-bottom:16px;">
              <label>模型名（可选）</label>
              <input type="text" id="stModel" placeholder="例如 deepseek-chat，留空用默认" />
            </div>
            <div style="display:flex; gap:12px; justify-content:flex-end;">
              <button class="btn btn-ghost" id="stTest">测试连接</button>
              <button class="btn btn-primary" id="stSave">保存设置</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // 读取服务端已有设置
    let savedSettings = { enabled: false, llmBaseUrl: '', llmModel: '', llmApiKey: '' };
    try {
      const r = await API.aiGetSettings();
      savedSettings = r.data.settings || savedSettings;
    } catch (e) {
      toast('读取设置失败：' + e.message, 'err');
    }

    const sw = document.getElementById('stEngineSwitch');
    const fields = document.getElementById('stLlmFields');
    const fBase = document.getElementById('stBaseUrl');
    const fKey = document.getElementById('stApiKey');
    const fModel = document.getElementById('stModel');

    fBase.value = savedSettings.llmBaseUrl || '';
    fModel.value = savedSettings.llmModel || '';
    fKey.value = savedSettings.llmApiKey || '';

    function syncSwitch() {
      const on = sw.getAttribute('aria-checked') === 'true';
      sw.classList.toggle('on', on);
      fields.style.display = on ? 'block' : 'none';
    }
    sw.setAttribute('aria-checked', savedSettings.enabled ? 'true' : 'false');
    syncSwitch();

    sw.addEventListener('click', () => {
      const cur = sw.getAttribute('aria-checked') === 'true';
      sw.setAttribute('aria-checked', cur ? 'false' : 'true');
      syncSwitch();
    });

    document.getElementById('stSave').addEventListener('click', async () => {
      const enabled = sw.getAttribute('aria-checked') === 'true';
      const baseUrl = fBase.value.trim();
      const apiKey = fKey.value.trim();
      const model = fModel.value.trim();
      if (enabled && (!baseUrl || !apiKey)) {
        niceAlert('开启大模型主持需要填写 API Base URL 和 API Key');
        return;
      }
      const btn = document.getElementById('stSave');
      btn.disabled = true; btn.textContent = '保存中...';
      try {
        await API.aiSaveSettings({ enabled, llmBaseUrl: baseUrl, llmModel: model, llmApiKey: apiKey });
        toast('设置已保存');
        // 保存后重新拉取，Key 回显以服务端为准
        const fresh = await API.aiGetSettings();
        fKey.value = fresh.data.settings.llmApiKey || '';
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
      } finally {
        btn.disabled = false; btn.textContent = '保存设置';
      }
    });

    document.getElementById('stTest').addEventListener('click', async () => {
      const baseUrl = fBase.value.trim();
      const apiKey = fKey.value.trim();
      const model = fModel.value.trim();
      if (!baseUrl || !apiKey) {
        niceAlert('请先填写 API Base URL 和 API Key');
        return;
      }
      const btn = document.getElementById('stTest');
      btn.disabled = true; btn.textContent = '连接中...';
      try {
        await API.aiTestSettings({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
        toast('连接成功，模型可用');
      } catch (e) {
        toast('连接失败：' + e.message, 'err');
      } finally {
        btn.disabled = false; btn.textContent = '测试连接';
      }
    });
  }

  // 选汤页：罗列海龟汤 + 游玩按钮
  async function renderAIPlay() {
    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">🤖 选择要游玩的海龟汤</h1>
          <p class="page-desc">选择一碗汤，与 AI 汤主展开推理对决</p>
        </div>
        <div class="soup-list" id="aiSoupList">
          <div class="empty"><p>加载中...</p></div>
        </div>
      </div>
    `;
    try {
      const data = await API.listSoups();
      const list = data.data.list || [];
      const listEl = document.getElementById('aiSoupList');
      if (list.length === 0) {
        listEl.innerHTML = `<div class="empty"><img src="/img/turtle.svg" alt="空" /><p>还没有海龟汤，先去「添加海龟汤」煮一碗吧 🐢</p></div>`;
        return;
      }
      // 读取该用户的陪玩存档：有存档的汤显示「继续游玩」按钮
      const saveMap = {};
      try {
        const sv = await API.aiSaves();
        (sv.data.list || []).forEach((s) => { saveMap[s.soupId] = s; });
      } catch (e) {
        // 存档接口失败不影响选汤列表
      }
      listEl.innerHTML = list.map((s, i) => `
        <div class="soup-row">
          <div class="soup-index">${i + 1}</div>
          <div class="soup-main">
            <div class="soup-title">${escapeHTML(s.title)}</div>
            <div class="soup-tags">
              ${typeTag(s.type)} ${styleTag(s.style)} ${starsHTML(s.difficulty)}
              <span class="soup-author">by ${escapeHTML(s.author || '匿名')}</span>
              ${saveMap[s.id] ? `<span class="soup-author">· 已存进度 ${saveMap[s.id].lastProgress}%</span>` : ''}
            </div>
          </div>
          <div class="soup-actions">
            ${saveMap[s.id] ? `<button class="btn btn-save" data-continue="${s.id}">继续游玩</button>` : ''}
            <button class="btn btn-primary" data-play="${s.id}">游玩</button>
          </div>
        </div>
      `).join('');
      listEl.querySelectorAll('[data-play]').forEach((btn) => {
        btn.addEventListener('click', () => {
          goto('#/ai/play/' + btn.dataset.play);
        });
      });
      listEl.querySelectorAll('[data-continue]').forEach((btn) => {
        btn.addEventListener('click', () => continueGame(btn.dataset.continue));
      });
    } catch (e) {
      document.getElementById('aiSoupList').innerHTML = `<div class="empty"><p>加载失败：${escapeHTML(e.message)}</p></div>`;
    }
  }

  // 难度选择页
  async function renderAIDifficulty(soupId) {
    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">⚔️ 选择难度</h1>
          <p class="page-desc">不同的难度决定了提问次数、倒计时与汤面完整度</p>
        </div>
        <div class="mode-cards" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
          <div class="mode-card" data-diff="easy">
            <div class="mode-icon">🟢</div>
            <h3>简单</h3>
            <p>35 次提问机会 · 汤面完整 · 无倒计时</p>
            <button class="btn btn-primary">开始</button>
          </div>
          <div class="mode-card" data-diff="master">
            <div class="mode-icon">🟡</div>
            <h3>汤达人</h3>
            <p>25 次提问机会 · 汤面完整 · 倒计时 30 分钟</p>
            <button class="btn btn-primary">开始</button>
          </div>
          <div class="mode-card" data-diff="sherlock">
            <div class="mode-icon">🔴</div>
            <h3>福尔摩斯</h3>
            <p>15 次提问机会 · 汤面删减 · 倒计时 10 分钟</p>
            <button class="btn btn-primary">开始</button>
          </div>
        </div>
      </div>
    `;
    document.querySelectorAll('[data-diff]').forEach((card) => {
      card.addEventListener('click', () => {
        startGame(soupId, card.dataset.diff);
      });
    });
  }

  // 游戏状态
  let gameState = null;

  // 从存档恢复游戏现场（继续游玩：还原聊天记录、推理进度、用时、剩余次数）
  async function continueGame(soupId) {
    try {
      const r = await API.aiGetSave(soupId);
      const s = r.data;
      const diff = DIFFICULTIES[s.diffKey] || DIFFICULTIES.easy;
      gameState = {
        soupId: s.soupId,
        title: s.soupTitle,
        face: s.face,
        bottom: s.bottom,
        type: s.type,
        style: s.style,
        diffKey: s.diffKey,
        diff: diff,
        totalQuestions: s.totalQuestions || diff.questions,
        remainingQuestions: s.remainingQuestions != null ? s.remainingQuestions : diff.questions,
        totalSeconds: diff.timer,
        remainingSeconds: s.remainingSeconds || 0,
        elapsedBase: s.elapsedSeconds || 0, // 之前已游玩的累计秒数
        history: Array.isArray(s.history) ? s.history : [],
        lastProgress: s.lastProgress || 0,
        startTime: Date.now(),
        status: 'playing',
      };
      // 传入历史对话，渲染时逐条重放
      renderGame(gameState.history);
      toast(`已恢复进度：推理 ${gameState.lastProgress}% · 剩余 ${gameState.remainingQuestions} 次提问`);
    } catch (e) {
      toast('恢复进度失败：' + e.message, 'err');
    }
  }

  // 开始游戏
  async function startGame(soupId, diffKey) {
    const diff = DIFFICULTIES[diffKey];
    if (!diff) return;
    try {
      const data = await API.getSoup(soupId);
      const s = data.data;
      let face = s.face;

      // 福尔摩斯难度：AI 删减汤面（依赖大模型；离线引擎/失败时用原汤面）
      if (diff.shorten) {
        toast('AI 正在删减汤面...');
        try {
          const r = await API.aiShorten({ face: s.face });
          face = r.data.face || s.face;
        } catch (e) {
          toast('汤面删减失败，使用原汤面：' + e.message, 'err');
        }
      }

      gameState = {
        soupId: s.id,
        title: s.title,
        face: face,
        bottom: s.bottom,
        type: s.type,
        style: s.style,
        diffKey: diffKey,
        diff: diff,
        totalQuestions: diff.questions,
        remainingQuestions: diff.questions,
        totalSeconds: diff.timer,
        remainingSeconds: diff.timer,
        elapsedBase: 0, // 累计已游玩秒数（继续游玩时从存档恢复）
        history: [],
        lastProgress: 0, // 最近一次智能体评估的推理进度
        startTime: Date.now(),
        status: 'playing', // playing / ended
      };

      renderGame();
    } catch (e) {
      toast('开始游戏失败：' + e.message, 'err');
    }
  }

  // 渲染游戏页（replayHistory：继续游玩时重放的历史对话 [{question, answer}]）
  function renderGame(replayHistory) {
    if (!gameState) return;
    const gs = gameState;

    main.innerHTML = `
      <div class="page game-page">
        <div class="page-head game-head">
          <h1 class="page-title">🕵️ AI 陪玩 · ${escapeHTML(gs.title)}</h1>
          <div class="game-hud">
            <span class="engine-badge" id="engineBadge">离线引擎</span>
            ${gs.totalSeconds > 0 ? `<div class="hud-timer" id="hudTimer">${formatTime(gs.remainingSeconds)}</div>` : '<div class="hud-timer hud-timer-none">无倒计时</div>'}
            <div class="hud-questions" id="hudQuestions">剩余 ${gs.remainingQuestions} 次</div>
          </div>
        </div>

        <div class="game-face-card">
          <div class="game-face-label">🥣 汤面</div>
          <div class="game-face-text">${escapeHTML(gs.face)}</div>
        </div>

        <div class="game-chat" id="gameChat">
          <div class="chat-empty">向 AI 汤主提问吧，它会用「是 / 否」回答你</div>
        </div>

        <!-- 推理进度条（智能体实时评估）：外框黑色薄边，初始灰色，>25%黄 / >50%金 / >75%绿 -->
        <div class="progress-agent" id="progressAgent">
          <div class="progress-agent-head">
            <span class="progress-agent-title">🧠 智能体推理进度</span>
            <span class="progress-pct" id="progressPct">0%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill lv-gray" id="progressFill" style="width:0%"></div>
          </div>
        </div>

        <div class="game-input-bar">
          <input type="text" id="gameInput" placeholder="输入你的问题（只能用是/否回答的问句）" maxlength="200" />
          <button class="btn btn-primary" id="gameSend">提问</button>
        </div>
        <div class="game-actions">
          <button class="btn btn-save" id="gameSaveExit">保存后退出</button>
          <button class="btn btn-danger" id="gameEnd">主动结束</button>
        </div>
      </div>
    `;

    document.getElementById('gameSend').addEventListener('click', () => askQuestion());
    document.getElementById('gameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') askQuestion();
    });
    document.getElementById('gameEnd').addEventListener('click', () => {
      endGame('主动结束');
    });
    document.getElementById('gameSaveExit').addEventListener('click', saveAndExit);

    // 重放历史对话（继续游玩时还原上次聊天记录）
    if (Array.isArray(replayHistory) && replayHistory.length) {
      replayHistory.forEach((t) => {
        if (t && t.question) appendChat('user', t.question);
        if (t && t.answer) appendChat('ai', t.answer);
      });
    }

    updateHUD();
    setProgressBar(gameState.lastProgress || 0);
    startTimer();
  }

  // 保存当前进度并退出（墨绿色按钮）：存档后返回选汤页，可随时「继续游玩」
  async function saveAndExit() {
    if (!gameState || gameState.status !== 'playing') return;
    const btn = document.getElementById('gameSaveExit');
    btn.disabled = true;
    btn.textContent = '保存中...';
    try {
      const elapsed = Math.floor((Date.now() - gameState.startTime) / 1000) + (gameState.elapsedBase || 0);
      await API.aiSave({
        soupId: gameState.soupId,
        soupTitle: gameState.title,
        face: gameState.face,
        bottom: gameState.bottom,
        type: gameState.type,
        style: gameState.style,
        diffKey: gameState.diffKey,
        diffLabel: gameState.diff.label,
        totalQuestions: gameState.totalQuestions,
        remainingQuestions: gameState.remainingQuestions,
        remainingSeconds: gameState.remainingSeconds,
        elapsedSeconds: elapsed,
        lastProgress: gameState.lastProgress,
        history: gameState.history,
      });
      clearInterval(timerInterval);
      toast('进度已保存，可随时在选汤页「继续游玩」');
      goto('#/ai/play');
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
      btn.disabled = false;
      btn.textContent = '保存后退出';
    }
  }

  // 推理进度条：按阈值切换颜色（≤25 灰 / ≤50 黄 / ≤75 金 / >75 绿）
  function setProgressBar(p) {
    const fill = document.getElementById('progressFill');
    const pct = document.getElementById('progressPct');
    if (!fill || !pct) return;
    const v = Math.max(0, Math.min(100, Math.round(Number(p) || 0)));
    fill.style.width = v + '%';
    pct.textContent = v + '%';
    fill.classList.remove('lv-gray', 'lv-yellow', 'lv-gold', 'lv-green');
    let lv = 'lv-gray';
    if (v > 75) lv = 'lv-green';
    else if (v > 50) lv = 'lv-gold';
    else if (v > 25) lv = 'lv-yellow';
    fill.classList.add(lv);
  }

  // 计时器
  let timerInterval = null;
  function startTimer() {
    clearInterval(timerInterval);
    if (!gameState || gameState.totalSeconds <= 0) return;
    timerInterval = setInterval(() => {
      if (!gameState || gameState.status !== 'playing') {
        clearInterval(timerInterval);
        return;
      }
      gameState.remainingSeconds--;
      if (gameState.remainingSeconds <= 0) {
        gameState.remainingSeconds = 0;
        clearInterval(timerInterval);
        endGame('倒计时结束');
        return;
      }
      updateHUD();
    }, 1000);
  }

  function updateHUD() {
    if (!gameState) return;
    const timerEl = document.getElementById('hudTimer');
    if (timerEl && gameState.totalSeconds > 0) {
      timerEl.textContent = formatTime(gameState.remainingSeconds);
    }
    const qEl = document.getElementById('hudQuestions');
    if (qEl) {
      const remain = gameState.remainingQuestions;
      qEl.textContent = '剩余 ' + remain + ' 次';
      // 小于 10 次：变红 + 光晕
      if (remain < 10) {
        qEl.classList.add('hud-low');
      } else {
        qEl.classList.remove('hud-low');
      }
    }
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // 提问
  async function askQuestion() {
    if (!gameState || gameState.status !== 'playing') return;
    const input = document.getElementById('gameInput');
    const question = input.value.trim();
    if (!question) return;
    if (gameState.remainingQuestions <= 0) {
      endGame('提问次数耗尽');
      return;
    }

    // 清空输入框，禁用发送
    input.value = '';
    const sendBtn = document.getElementById('gameSend');
    sendBtn.disabled = true;
    sendBtn.textContent = '推理中...';

    // 渲染用户问题到聊天区
    appendChat('user', question);

    try {
      // 引擎由服务端决定（大模型 / 离线引擎），前端不再强制要求本地配置
      const r = await API.aiAsk({
        soupId: gameState.soupId,
        face: gameState.face,
        bottom: gameState.bottom,
        history: gameState.history,
        question: question,
        lastProgress: gameState.lastProgress,
      });
      const answer = r.data.answer;
      let progress = r.data.progress;
      const engine = r.data.engine;

      // 记录历史
      gameState.history.push({ question, answer });
      gameState.remainingQuestions--;

      // 智能体进度未知（-1）时保留上一次进度；且进度单调不减——已确认的信息不会消失
      if (typeof progress !== 'number' || progress < 0) progress = gameState.lastProgress;
      progress = Math.max(gameState.lastProgress, progress);
      gameState.lastProgress = progress;

      // 渲染 AI 回答 + 刷新进度条 + 引擎徽标
      appendChat('ai', answer);
      setProgressBar(progress);
      setEngineBadge(engine);

      updateHUD();

      // 判断结束条件
      if (progress >= 90) {
        setTimeout(() => endGame('推理进度达到 ' + progress + '%', progress), 800);
        return;
      }
      if (gameState.remainingQuestions <= 0) {
        setTimeout(() => endGame('提问次数耗尽', progress), 800);
        return;
      }
    } catch (e) {
      appendChat('ai', '（AI 调用失败：' + e.message + '）');
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = '提问';
    }
  }

  // 更新引擎徽标（大模型主持 / 内置离线引擎）
  function setEngineBadge(engine) {
    const badge = document.getElementById('engineBadge');
    if (!badge) return;
    if (engine === 'llm') {
      badge.textContent = '大模型主持';
      badge.classList.add('llm');
    } else {
      badge.textContent = '内置离线引擎';
      badge.classList.remove('llm');
    }
  }

  function appendChat(role, text) {
    const chat = document.getElementById('gameChat');
    const emptyEl = chat.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();
    const div = document.createElement('div');
    div.className = 'chat-msg chat-' + role;
    if (role === 'ai') {
      div.textContent = text;
    } else {
      div.innerHTML = '<span class="chat-q">问：</span>' + escapeHTML(text);
    }
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  // 结束游戏
  function endGame(reason, progress) {
    if (!gameState || gameState.status === 'ended') return;
    clearInterval(timerInterval);
    gameState.status = 'ended';
    gameState.endReason = reason;

    // 用时 = 本次会话 + 存档前累计（继续游玩时正确累计总用时）
    const usedSeconds = Math.floor((Date.now() - gameState.startTime) / 1000) + (gameState.elapsedBase || 0);
    const usedQuestions = gameState.totalQuestions - gameState.remainingQuestions;

    // 若没有明确 progress，用智能体最近一次评估兜底
    if (progress === undefined || progress < 0) {
      progress = gameState.lastProgress || 0;
    }

    main.innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1 class="page-title">🏁 游戏结束</h1>
          <p class="page-desc">${escapeHTML(reason)}</p>
        </div>

        <div class="form-card game-result-card">
          <div class="result-stats">
            <div class="result-item">
              <div class="result-label">游玩时间</div>
              <div class="result-value">${formatTime(usedSeconds)}</div>
            </div>
            <div class="result-item">
              <div class="result-label">已提问次数</div>
              <div class="result-value">${usedQuestions} 次</div>
            </div>
            <div class="result-item">
              <div class="result-label">推理进度</div>
              <div class="result-value">${progress}%</div>
            </div>
          </div>

          <div class="result-bottom">
            <h3>🔍 完整汤底</h3>
            <div class="modal-scroll" style="max-height:none;">${escapeHTML(gameState.bottom)}</div>
          </div>

          <div style="display:flex; gap:12px; justify-content:center; margin-top:24px;">
            <button class="btn btn-ghost" id="resultBack">返回汤库</button>
            <button class="btn btn-primary" id="resultAgain">再玩一次</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('resultBack').addEventListener('click', () => {
      goto('#/ai/play');
    });
    document.getElementById('resultAgain').addEventListener('click', () => {
      // 回到难度选择
      goto('#/ai/play/' + gameState.soupId);
    });
  }

  // ==================== 退出登录 ====================
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await API.logout(); } catch (e) {}
    API.setToken('');
    location.href = '/index.html';
  });

  // 点击左下角用户信息 → 进入个人设置（修改 AI 接口配置）
  document.getElementById('userChip').addEventListener('click', () => {
    goto('#/settings');
  });

  // ==================== 工具：HTML 转义 ====================
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ==================== 启动 ====================
  (async function init() {
    const user = await checkAuth();
    if (!user) return;
    navigate();
  })();
})();
