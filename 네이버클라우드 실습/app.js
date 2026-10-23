const API_BASE_URL = window.API_BASE_URL || 'http://localhost:8080';
const state = { user: null, profile: { nickname: '', gender: '', birthYear: '', introduction: '', interests: [] } };

// 백엔드가 준비되면 fetch 호출을 이 모듈에 모아 실제 API로 교체합니다.
const api = {
  async signIn(email, password) {
    await delay(350);
    if (!email || !password) throw new Error('이메일과 비밀번호를 입력해 주세요.');
    state.user = { id: 1, name: '가궁이', email };
    return state.user;
  },
  async signUp(payload) { await delay(350); return payload; },
  async saveProfile(profile) { await delay(350); state.profile = profile; return profile; },
  async getRecommendations() { await delay(250); return demoProfiles; }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const demoProfiles = [
  { name: '서윤', age: 27, district: '마포구', bio: '전시와 산책, 맛있는 커피를 좋아해요.', emoji: '🌿', tags: ['전시', '산책'] },
  { name: '민준', age: 29, district: '성수동', bio: '주말에는 러닝하고 새로운 식당을 찾아요.', emoji: '🏃', tags: ['러닝', '맛집'] },
  { name: '지아', age: 26, district: '연남동', bio: '함께 영화 이야기 나눌 분을 찾고 있어요.', emoji: '🎬', tags: ['영화', '여행'] }
];

function layout(content, active = '') {
  return `<header class="header"><a class="brand" href="#/home">KKAGUNG<span>.</span></a><nav>${state.user ? `<a href="#/home" class="${active === 'home' ? 'active' : ''}">홈</a><a href="#/profile" class="${active === 'profile' ? 'active' : ''}">내 프로필</a><button class="link-button" id="logout">로그아웃</button>` : `<a href="#/login">로그인</a><a class="nav-join" href="#/signup">가입하기</a>`}</nav></header><main>${content}</main><footer>© 2026 KKAGUNG · Phase 1 frontend prototype</footer>`;
}

function landing() { return layout(`<section class="hero"><p class="eyebrow">나답게, 천천히</p><h1>좋은 인연은<br><em>가까운 취향</em>에서 시작돼요.</h1><p class="hero-copy">관심사와 생활 리듬을 바탕으로, 부담 없이 새로운 사람을 만나 보세요.</p><a class="button" href="#/signup">내 인연 찾기 <span>→</span></a><div class="hero-card"><div class="avatar">✦</div><div><strong>오늘의 취향 연결</strong><p>서로의 이야기를 존중하는 만남</p></div></div></section>`); }

function login() { return layout(`<section class="auth"><div class="auth-title"><p class="eyebrow">WELCOME BACK</p><h1>다시 만나서<br>반가워요.</h1><p>KKAGUNG에서 이어 온 이야기를 확인하세요.</p></div><form id="login-form" class="form-card"><label>이메일<input name="email" type="email" placeholder="name@example.com" required></label><label>비밀번호<input name="password" type="password" placeholder="비밀번호를 입력해 주세요" required></label><p class="form-error" aria-live="polite"></p><button class="button" type="submit">로그인</button><p class="form-bottom">아직 회원이 아니신가요? <a href="#/signup">가입하기</a></p></form></section>`); }

function signup() { return layout(`<section class="auth"><div class="auth-title"><p class="eyebrow">JOIN KKAGUNG</p><h1>당신의 이야기를<br>들려주세요.</h1><p>가입 후 나를 표현하는 프로필을 완성할 수 있어요.</p></div><form id="signup-form" class="form-card"><label>이름<input name="name" placeholder="이름" required></label><label>이메일<input name="email" type="email" placeholder="name@example.com" required></label><label>비밀번호<input name="password" type="password" minlength="8" placeholder="8자 이상" required></label><label class="check"><input type="checkbox" required> 서비스 이용약관 및 개인정보 처리방침에 동의합니다.</label><p class="form-error" aria-live="polite"></p><button class="button" type="submit">가입하고 시작하기</button><p class="form-bottom">이미 계정이 있으신가요? <a href="#/login">로그인</a></p></form></section>`); }

function profile() { const p = state.profile; return layout(`<section class="profile-page"><div><p class="eyebrow">MY PROFILE</p><h1>나를 소개해<br>주세요.</h1><p>입력한 정보는 추천 결과를 개인화하는 데 사용됩니다.</p></div><form id="profile-form" class="form-card profile-form"><label>닉네임<input name="nickname" value="${p.nickname}" placeholder="다른 사람에게 보일 이름" required></label><div class="two-cols"><label>성별<select name="gender" required><option value="">선택</option><option ${p.gender === '여성' ? 'selected' : ''}>여성</option><option ${p.gender === '남성' ? 'selected' : ''}>남성</option><option ${p.gender === '기타' ? 'selected' : ''}>기타</option></select></label><label>출생연도<input name="birthYear" value="${p.birthYear}" inputmode="numeric" placeholder="1998" required></label></div><label>한 줄 소개<textarea name="introduction" placeholder="나를 가장 잘 표현하는 문장을 적어 주세요.">${p.introduction}</textarea></label><fieldset><legend>관심사 <small>(복수 선택)</small></legend><div class="chips">${['여행','영화','운동','전시','맛집','독서'].map(interest => `<label><input type="checkbox" name="interests" value="${interest}" ${p.interests.includes(interest) ? 'checked' : ''}><span>${interest}</span></label>`).join('')}</div></fieldset><p class="form-error" aria-live="polite"></p><button class="button" type="submit">프로필 저장하기</button></form></section>`, 'profile'); }

function home() { const name = state.profile.nickname || state.user?.name || '가궁이'; return layout(`<section class="home"><div class="home-intro"><p class="eyebrow">FOR YOU</p><h1>${name}님을 위한<br>오늘의 연결</h1><p>취향과 활동 지역이 비슷한 분들이에요.</p><a href="#/profile" class="text-link">내 프로필 수정하기 →</a></div><div id="recommendations" class="profile-grid"><div class="loading">추천을 불러오는 중이에요…</div></div></section>`, 'home'); }

function renderCards(profiles) { document.querySelector('#recommendations').innerHTML = profiles.map(p => `<article class="person-card"><div class="person-image">${p.emoji}<span>추천</span></div><div class="person-info"><h2>${p.name} <small>${p.age}</small></h2><p class="district">⌖ ${p.district}</p><p>${p.bio}</p><div>${p.tags.map(tag => `<span class="tag">#${tag}</span>`).join('')}</div><button class="outline-button" data-name="${p.name}">관심 보내기</button></div></article>`).join(''); document.querySelectorAll('[data-name]').forEach(button => button.onclick = () => { button.textContent = '관심을 보냈어요 ✓'; button.disabled = true; }); }

function bind(route) {
  const form = document.querySelector('#login-form');
  if (form) form.onsubmit = async e => { e.preventDefault(); const data = Object.fromEntries(new FormData(form)); try { await api.signIn(data.email, data.password); location.hash = '#/home'; } catch (error) { form.querySelector('.form-error').textContent = error.message; } };
  const signupForm = document.querySelector('#signup-form');
  if (signupForm) signupForm.onsubmit = async e => { e.preventDefault(); const data = Object.fromEntries(new FormData(signupForm)); await api.signUp(data); state.user = { id: 1, name: data.name, email: data.email }; location.hash = '#/profile'; };
  const profileForm = document.querySelector('#profile-form');
  if (profileForm) profileForm.onsubmit = async e => { e.preventDefault(); const data = new FormData(profileForm); const profile = { ...Object.fromEntries(data), interests: data.getAll('interests') }; await api.saveProfile(profile); location.hash = '#/home'; };
  const logout = document.querySelector('#logout');
  if (logout) logout.onclick = () => { state.user = null; location.hash = '#/'; };
  if (route === '/home') api.getRecommendations().then(renderCards);
}

function router() { const route = location.hash.replace('#', '') || '/'; const protectedRoute = route === '/home' || route === '/profile'; if (protectedRoute && !state.user) { location.hash = '#/login'; return; } const pages = { '/': landing, '/login': login, '/signup': signup, '/profile': profile, '/home': home }; document.querySelector('#app').innerHTML = (pages[route] || landing)(); bind(route); window.scrollTo(0, 0); }
window.addEventListener('hashchange', router);
router();
