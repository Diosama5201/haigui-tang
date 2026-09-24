/**
 * 登录 / 注册页逻辑
 */
(function () {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const toRegister = document.getElementById('toRegister');
  const toLogin = document.getElementById('toLogin');

  function switchTo(showRegister) {
    loginForm.style.display = showRegister ? 'none' : 'block';
    registerForm.style.display = showRegister ? 'block' : 'none';
  }

  toRegister.addEventListener('click', () => switchTo(true));
  toLogin.addEventListener('click', () => switchTo(false));

  function alert(msg) {
    window.alert(msg);
  }

  // 登录
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!username || !password) {
      alert('请输入用户名和密码');
      return;
    }
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.textContent = '登录中...';
    try {
      const data = await API.login(username, password);
      API.setToken(data.data.token);
      // 登录成功跳转到主站
      location.href = '/app.html';
    } catch (err) {
      alert('登录失败：' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  });

  // 注册
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value;
    const password2 = document.getElementById('regPassword2').value;
    if (!username || !password) {
      alert('请输入用户名和密码');
      return;
    }
    if (username.length < 2 || username.length > 20) {
      alert('用户名长度需在 2~20 个字符之间');
      return;
    }
    if (password.length < 4) {
      alert('密码长度至少 4 位');
      return;
    }
    if (password !== password2) {
      alert('两次输入的密码不一致');
      return;
    }
    const btn = document.getElementById('regBtn');
    btn.disabled = true;
    btn.textContent = '注册中...';
    try {
      const data = await API.register(username, password);
      alert('注册成功！请登录');
      switchTo(false);
      document.getElementById('loginUsername').value = username;
      document.getElementById('loginPassword').value = '';
    } catch (err) {
      alert('注册失败：' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '注 册';
    }
  });
})();
