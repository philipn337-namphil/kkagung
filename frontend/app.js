// Encode untrusted values for HTML text, quoted attributes and textarea content.
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const API_BASE_URL = (window.API_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const API_PREFIX = `${API_BASE_URL}/api/v1`;
const state = { token: sessionStorage.getItem('kkagung_token'), user: null, profile: null };

const request = async (path, { method = 'GET', body } = {}) => {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(`${API_PREFIX}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) throw new Error(payload?.error?.message || '요청을 처리하지 못했습니다.');
  return payload.data;
};

const hydrate = data => {
  state.user = data;
  state.profile = data.profile ? { ...data.profile, birthDate: data.profile.birthDate?.slice(0, 10) } : null;
};

const api = {
  async restoreSession() {
    if (!state.token) return false;
    try { hydrate(await request('/me')); return true; }
    catch { this.signOut(); return false; }
  },
  async signIn(email, password) {
    const data = await request('/auth/login', { method: 'POST', body: { email, password } });
    state.token = data.token;
    sessionStorage.setItem('kkagung_token', data.token);
    hydrate(await request('/me'));
    return state.user;
  },
  async signUp({ email, password, adultVerified }) {
    const data = await request('/auth/register', { method: 'POST', body: { email, password, adultVerified } });
    state.token = data.token;
    sessionStorage.setItem('kkagung_token', data.token);
    hydrate(await request('/me'));
    return state.user;
  },
  async saveProfile({ profile, preferences }) {
    const savedProfile = await request('/me/profile', { method: 'PUT', body: profile });
    await request('/me/preferences', { method: 'PUT', body: preferences });
    state.profile = { ...savedProfile, birthDate: savedProfile.birthDate?.slice(0, 10) };
    return savedProfile;
  },
  signOut() { state.token = null; state.user = null; state.profile = null; sessionStorage.removeItem('kkagung_token'); },
  async getRecommendations() { return demoProfiles; }
};

const demoProfiles = [
  { name: '서윤', age: 27, district: '마포구', bio: '전시와 산책, 맛있는 커피를 좋아해요.', emoji: '🌿', tags: ['전시', '산책'] },
  { name: '민준', age: 29, district: '성수동', bio: '주말에는 러닝하고 새로운 식당을 찾아요.', emoji: '🏃', tags: ['러닝', '맛집'] },
  { name: '지아', age: 26, district: '연남동', bio: '함께 영화 이야기 나눌 분을 찾고 있어요.', emoji: '🎬', tags: ['영화', '여행'] }
];

function layout(content, active = '') {
  return `<header class="header"><a class="brand" href="#/home">KKAGUNG<span>.</span></a><nav>${state.user ? `<a href="#/home" class="${active === 'home' ? 'active' : ''}">홈</a><a href="#/profile" class="${active === 'profile' ? 'active' : ''}">내 프로필</a><button class="link-button" id="logout">로그아웃</button>` : `<a href="#/login">로그인</a><a class="nav-join" href="#/signup">가입하기</a>`}</nav></header><main>${content}</main><footer>© 2026 KKAGUNG · Phase 1</footer>`;
}

function landing() { return layout(`<section class="hero"><p class="eyebrow">나답게, 천천히</p><h1>좋은 인연은<br><em>가까운 취향</em>에서 시작돼요.</h1><p class="hero-copy">관심사와 생활 리듬을 바탕으로, 부담 없이 새로운 사람을 만나 보세요.</p><a class="button" href="#/signup">내 인연 찾기 <span>→</span></a><div class="hero-card"><div class="avatar">✦</div><div><strong>오늘의 취향 연결</strong><p>서로의 이야기를 존중하는 만남</p></div></div></section>`); }

function login() { return layout(`<section class="auth"><div class="auth-title"><p class="eyebrow">WELCOME BACK</p><h1>다시 만나서<br>반가워요.</h1><p>가입한 계정으로 로그인해 주세요.</p></div><form id="login-form" class="form-card"><label>이메일<input name="email" type="email" placeholder="name@example.com" required></label><label>비밀번호<input name="password" type="password" minlength="8" placeholder="8자 이상" required></label><p class="form-error" aria-live="polite"></p><button class="button" type="submit">로그인</button><p class="form-bottom">아직 회원이 아니신가요? <a href="#/signup">가입하기</a></p></form></section>`); }

function signup() { return layout(`<section class="auth"><div class="auth-title"><p class="eyebrow">JOIN KKAGUNG</p><h1>당신의 이야기를<br>들려주세요.</h1><p>성인 인증 확인 후 프로필을 등록할 수 있어요.</p></div><form id="signup-form" class="form-card"><label>이메일<input name="email" type="email" placeholder="name@example.com" required></label><label>비밀번호<input name="password" type="password" minlength="8" placeholder="8자 이상" required></label><label class="check"><input name="adultVerified" type="checkbox" required> 성인 인증 및 서비스 이용약관에 동의합니다.</label><p class="form-error" aria-live="polite"></p><button class="button" type="submit">가입하고 시작하기</button><p class="form-bottom">이미 회원이신가요? <a href="#/login">로그인</a></p></form></section>`); }

function profile() {
  const p = state.profile || {};
  const pref = state.user?.preference || {};
  return layout(`<section class="profile-page"><div><p class="eyebrow">MY PROFILE</p><h1>나를 소개해<br>주세요.</h1><p>필수 프로필과 선호 조건은 실제 서버에 안전하게 저장됩니다.</p></div><form id="profile-form" class="form-card profile-form"><label>표시 이름<input name="displayName" value="${escapeHTML(p.displayName || '')}" maxlength="30" required></label><div class="two-cols"><label>생년월일<input name="birthDate" type="date" value="${escapeHTML(p.birthDate || '')}" required></label><label>성별<select name="gender" required><option value="">선택</option><option value="MALE" ${p.gender === 'MALE' ? 'selected' : ''}>남성</option><option value="FEMALE" ${p.gender === 'FEMALE' ? 'selected' : ''}>여성</option><option value="OTHER" ${p.gender === 'OTHER' ? 'selected' : ''}>기타</option></select></label></div><div class="two-cols"><label>지역 코드<input name="regionCode" value="${escapeHTML(p.regionCode || 'SEOUL_DONGDAEMUN')}" required></label><label>키(cm)<input name="heightCm" type="number" min="100" max="250" value="${escapeHTML(p.heightCm || '')}" required></label></div><div class="two-cols"><label>직업<select name="jobCategory" required><option value="STUDENT" ${p.jobCategory === 'STUDENT' ? 'selected' : ''}>학생</option><option value="OFFICE_WORKER" ${p.jobCategory === 'OFFICE_WORKER' ? 'selected' : ''}>직장인</option><option value="FREELANCER" ${p.jobCategory === 'FREELANCER' ? 'selected' : ''}>프리랜서</option><option value="SELF_EMPLOYED" ${p.jobCategory === 'SELF_EMPLOYED' ? 'selected' : ''}>자영업</option><option value="OTHER" ${p.jobCategory === 'OTHER' ? 'selected' : ''}>기타</option></select></label><label>MBTI<input name="mbti" value="${escapeHTML(p.mbti || '')}" maxlength="4" placeholder="INTJ" required></label></div><label>한 줄 소개<textarea name="intro" maxlength="200" placeholder="나를 가장 잘 표현하는 문장을 적어 주세요.">${escapeHTML(p.intro || '')}</textarea></label><fieldset><legend>선호 조건</legend><div class="two-cols"><label>선호 성별<select name="preferredGender" required><option value="MALE" ${pref.preferredGender === 'MALE' ? 'selected' : ''}>남성</option><option value="FEMALE" ${pref.preferredGender === 'FEMALE' ? 'selected' : ''}>여성</option><option value="OTHER" ${pref.preferredGender === 'OTHER' ? 'selected' : ''}>기타</option></select></label><label>선호 지역<input name="preferredRegion" value="${escapeHTML(pref.regionScope?.[0] || p.regionCode || 'SEOUL_DONGDAEMUN')}" required></label></div><div class="two-cols"><label>최소 나이<input name="minAge" type="number" min="19" max="99" value="${escapeHTML(pref.minAge || 20)}" required></label><label>최대 나이<input name="maxAge" type="number" min="19" max="99" value="${escapeHTML(pref.maxAge || 35)}" required></label></div></fieldset><p class="form-error" aria-live="polite"></p><button class="button" type="submit">프로필 저장하기</button></form></section>`, 'profile');
}

function home() { const name = state.profile?.displayName || state.user?.email?.split('@')[0] || '가궁이'; return layout(`<section class="home"><div class="home-intro"><p class="eyebrow">FOR YOU</p><h1>${escapeHTML(name)}님을 위한<br>오늘의 연결</h1><p>Phase 1에서는 추천 화면 목업을 제공합니다. 실제 운세·추천은 Phase 2 API에서 연결됩니다.</p><a href="#/profile" class="text-link">내 프로필 수정하기 →</a></div><div id="recommendations" class="profile-grid"><div class="loading">추천을 불러오는 중이에요…</div></div></section>`, 'home'); }

function renderCards(profiles) { document.querySelector('#recommendations').innerHTML = profiles.map(p => `<article class="person-card"><div class="person-image">${escapeHTML(p.emoji)}<span>추천</span></div><div class="person-info"><h2>${escapeHTML(p.name)} <small>${escapeHTML(p.age)}</small></h2><p class="district">⌖ ${escapeHTML(p.district)}</p><p>${escapeHTML(p.bio)}</p><div>${p.tags.map(tag => `<span class="tag">#${escapeHTML(tag)}</span>`).join('')}</div><button class="outline-button" data-name="${escapeHTML(p.name)}">관심 보내기</button></div></article>`).join(''); document.querySelectorAll('[data-name]').forEach(button => button.onclick = () => { button.textContent = '관심을 보냈어요 ✓'; button.disabled = true; }); }

function showError(form, error) { form.querySelector('.form-error').textContent = error.message || '요청을 처리하지 못했습니다.'; }
function bind(route) {
  const form = document.querySelector('#login-form');
  if (form) form.onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); try { await api.signIn(data.email, data.password); location.hash = '#/home'; } catch (error) { showError(form, error); } };
  const signupForm = document.querySelector('#signup-form');
  if (signupForm) signupForm.onsubmit = async event => { event.preventDefault(); const data = new FormData(signupForm); try { await api.signUp({ email: data.get('email'), password: data.get('password'), adultVerified: data.get('adultVerified') === 'on' }); location.hash = '#/profile'; } catch (error) { showError(signupForm, error); } };
  const profileForm = document.querySelector('#profile-form');
  if (profileForm) profileForm.onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(profileForm)); try { await api.saveProfile({ profile: { displayName: data.displayName, birthDate: data.birthDate, gender: data.gender, regionCode: data.regionCode, heightCm: Number(data.heightCm), jobCategory: data.jobCategory, mbti: data.mbti.toUpperCase(), intro: data.intro || null }, preferences: { preferredGender: data.preferredGender, minAge: Number(data.minAge), maxAge: Number(data.maxAge), regionScope: [data.preferredRegion] } }); location.hash = '#/home'; } catch (error) { showError(profileForm, error); } };
  const logout = document.querySelector('#logout');
  if (logout) logout.onclick = () => { api.signOut(); location.hash = '#/'; };
  if (route === '/home') api.getRecommendations().then(renderCards);
}

async function router() {
  const route = location.hash.replace('#', '') || '/';
  const protectedRoute = route === '/home' || route === '/profile';
  if (protectedRoute && !state.user && !(await api.restoreSession())) { location.hash = '#/login'; return; }
  const pages = { '/': landing, '/login': login, '/signup': signup, '/profile': profile, '/home': home };
  document.querySelector('#app').innerHTML = (pages[route] || landing)();
  bind(route);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);
router();
