const API_BASE_URL = (window.API_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const API_PREFIX = `${API_BASE_URL}/api/v1`;
const STORAGE_KEY = 'kkagung.access-token';
const state = { token: sessionStorage.getItem(STORAGE_KEY), user: null, me: null, daily: null, cards: [], images: [], notices: [],
  // 서버가 준 값을 담아 두는 자리다. hearted 는 추천 응답의 heartedUserIds 로 채우고,
  // sentRequests 는 이번 세션에 보낸 채팅 요청이라 목록을 다시 받기 전까지 버튼 상태를 유지한다.
  hearted: new Set(), sentRequests: [] };

class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const displayDate = value => value ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)) : '-';
const apiUrl = path => `${API_PREFIX}${path}`;
// 운영에서 비활성인 개발 전용 경로와 실제 "대상 없음"(404)을 목업으로 가리지 않는다.
function setToken(token) { state.token = token || null; token ? sessionStorage.setItem(STORAGE_KEY, token) : sessionStorage.removeItem(STORAGE_KEY); }
function showNotice(message, type = 'success') { state.notices = [{ message, type }]; renderNotices(); }
function renderNotices() { const slot = document.querySelector('#toast'); if (slot) slot.innerHTML = state.notices.map(n => `<p class="toast ${n.type}">${escapeHtml(n.message)}</p>`).join(''); }
function renderError(error, target) { if (!target) return; const prefix = ({ 401: '로그인이 필요하거나 만료되었습니다.', 403: '이 작업을 할 권한이 없습니다.', 409: '현재 상태에서는 요청을 처리할 수 없습니다.', 429: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' })[error.status] || ''; target.innerHTML = `<div class="status-card error"><strong>${error.status || '연결'} 오류</strong><p>${escapeHtml(prefix || error.message)}</p><small>${escapeHtml(error.code || '')}</small></div>`; }

async function request(path, options = {}) {
  // FormData 에는 Content-Type 을 직접 붙이지 않는다. 브라우저가 multipart 경계까지 넣어야 한다.
  const json = options.body !== undefined && !(options.body instanceof FormData);
  const headers = { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try { response = await fetch(apiUrl(path), { ...options, headers }); } catch { throw new ApiError(0, 'NETWORK_ERROR', 'API 서버에 연결할 수 없습니다.'); }
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON response */ }
  if (!response.ok || body?.success === false) throw new ApiError(response.status, body?.error?.code || 'REQUEST_FAILED', body?.error?.message || '요청을 처리하지 못했습니다.');
  return body.data;
}


// 서버가 답하지 않으면 그대로 오류를 올린다. 화면이 대신 그럴듯한 값을 지어내지 않는다.
// 목업으로 가려 두면 무엇이 동작하고 무엇이 안 되는지 아무도 구분할 수 없다.
const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: payload => request('/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  // 이미 만료된 토큰으로 로그아웃해도 결과는 같다. 401 은 실패로 보지 않는다.
  async logout() { try { await request('/auth/logout', { method: 'POST', body: '{}' }); } catch (error) { if (error.status !== 401) throw error; } },
  me: () => request('/me'),
  saveProfile: payload => request('/me/profile', { method: 'PUT', body: JSON.stringify(payload) }),
  savePreferences: payload => request('/me/preferences', { method: 'PUT', body: JSON.stringify(payload) }),
  // 개발 편의 라우터라 운영에서는 등록되지 않는다. 그때는 로그인 화면의 목록이 비어 있다.
  async testAccounts() { return (await request('/dev/test-accounts')).accounts; },
  testLogin: accountId => request(`/dev/test-accounts/${accountId}/token`, { method: 'POST' }),
  openDaily: () => request('/daily/open', { method: 'POST' }),
  recommendations: () => request('/recommendations/today'),
  refresh: () => request('/recommendations/refresh', { method: 'POST' }),
  heart: (id, remove = false) => request(`/cards/${id}/hearts`, { method: remove ? 'DELETE' : 'POST' }),
  receivedHearts: () => request('/hearts/received'),
  cardDetail: id => request(`/cards/${id}`),
  sendChatRequest: (targetUserId, message) => request('/chat-requests', { method: 'POST', body: JSON.stringify({ targetUserId, message }) }),
  chatRequests: kind => request(`/chat-requests/${kind}`),
  resolveRequest: (id, action) => request(`/chat-requests/${id}/${action}`, { method: 'POST' }),
  rooms: () => request('/chat-rooms'),
  room: id => request(`/chat-rooms/${id}`),
  messages: id => request(`/chat-rooms/${id}/messages`),
  sendMessage: (id, body) => request(`/chat-rooms/${id}/messages`, { method: 'POST', body: JSON.stringify({ body }) }),
  block: id => request('/me/blocks', { method: 'POST', body: JSON.stringify({ targetUserId: id }) }),
  report: payload => request('/reports', { method: 'POST', body: JSON.stringify(payload) }),
  images: () => request('/me/images'),
  uploadImage(file, slot) { const form = new FormData(); form.append('file', file); if (slot) form.append('slot', String(slot)); return request('/me/images', { method: 'POST', body: form }); },
  deleteImage: imageId => request(`/me/images/${imageId}`, { method: 'DELETE' }),
  admin: path => request(`/admin/${path}`),
};

function layout(content, active = '') { const nav = state.user ? `<a href="#/home" class="${active === 'home' ? 'active' : ''}">홈</a><a href="#/inbox" class="${active === 'inbox' ? 'active' : ''}">받은 알림</a><a href="#/chats" class="${active === 'chats' ? 'active' : ''}">채팅</a><a href="#/mypage" class="${active === 'mypage' ? 'active' : ''}">마이</a>${state.user.role === 'ADMIN' ? '<a href="#/admin" class="admin-link">관리</a>' : ''}<button class="link-button" id="logout">로그아웃</button>` : `<a href="#/login">로그인</a><a class="nav-join" href="#/signup">가입하기</a>`; return `<header class="header"><a class="brand" href="#/home">KKAGUNG<span>.</span></a><nav>${nav}</nav></header><div id="toast" aria-live="polite"></div><main>${content}</main><footer>© 2026 KKAGUNG</footer>`; }
function landing() { return layout(`<section class="hero"><p class="eyebrow">TODAY'S CONNECTION</p><h1>나답게, 천천히<br><em>좋은 인연</em>을 만나세요.</h1><p class="hero-copy">매일 오전 8시에 열리는 운세와 추천 카드. 실제 사진은 서로의 채팅 요청이 수락된 뒤에만 공개돼요.</p><a class="button" href="#/login">오늘의 인연 보기 <span>→</span></a><div class="hero-card"><div class="avatar">✦</div><div><strong>공개는 동의 이후에</strong><p>AI 또는 흐림 프로필로 먼저 만나세요.</p></div></div></section>`); }
function login() { return layout(`<section class="auth"><div class="auth-title"><p class="eyebrow">WELCOME BACK</p><h1>오늘의<br>인연을 열어보세요.</h1><p>로그인하면 오늘의 운세와 추천을 확인할 수 있어요.</p><div class="test-login"><h2>개발용 테스트 계정</h2><div id="test-accounts"><span class="muted">계정 목록을 불러오는 중…</span></div></div></div><form id="login-form" class="form-card"><label>이메일<input name="email" type="email" placeholder="name@example.com" required></label><label>비밀번호<input name="password" type="password" placeholder="비밀번호를 입력해 주세요" required></label><p class="form-error" aria-live="polite"></p><button class="button" type="submit">로그인</button><p class="form-bottom">아직 회원이 아니신가요? <a href="#/signup">가입하기</a></p></form></section>`); }
function signup() { return layout(`<section class="auth"><div class="auth-title"><p class="eyebrow">JOIN KKAGUNG</p><h1>당신의 이야기를<br>들려주세요.</h1><p>성인 인증을 마친 사용자만 이용할 수 있어요.</p></div><form id="signup-form" class="form-card"><label>이메일<input name="email" type="email" placeholder="name@example.com" required></label><label>비밀번호<input name="password" type="password" minlength="8" placeholder="8자 이상" required></label><label class="check"><input name="adultVerified" type="checkbox" required> 만 19세 이상이며 서비스 이용에 동의합니다.</label><p class="form-error" aria-live="polite"></p><button class="button" type="submit">가입하고 시작하기</button><p class="form-bottom">이미 회원이신가요? <a href="#/login">로그인</a></p></form></section>`); }
function options(values, selected, labels = {}) { return `<option value="" ${selected ? '' : 'selected'} disabled>선택</option>${values.map(value => `<option value="${value}" ${selected === value ? 'selected' : ''}>${labels[value] || value}</option>`).join('')}`; }
function profile() { const p = state.me?.profile || {}; const preference = state.me?.preference || {}; return layout(`<section class="profile-page"><div><p class="eyebrow">MY PROFILE</p><h1>나를 소개해<br>주세요.</h1><p>프로필과 선호 조건을 저장하면 오늘의 추천을 열 수 있어요.</p></div><form id="profile-form" class="form-card profile-form"><h2>내 프로필</h2><label>이름<input name="displayName" value="${escapeHtml(p.displayName || '')}" required></label><div class="two-cols"><label>생년월일<input name="birthDate" type="date" value="${String(p.birthDate || '').slice(0, 10)}" required></label><label>성별<select name="gender" required>${options(['MALE','FEMALE','OTHER'], p.gender, { MALE: '남성', FEMALE: '여성', OTHER: '기타' })}</select></label></div><label>지역 코드<input name="regionCode" value="${escapeHtml(p.regionCode || 'SEOUL_MAPO')}" required></label><div class="two-cols"><label>키(cm)<input name="heightCm" type="number" min="100" max="250" value="${escapeHtml(p.heightCm || '')}" required></label><label>직업<select name="jobCategory">${options(['STUDENT','OFFICE_WORKER','FREELANCER','SELF_EMPLOYED','OTHER'], p.jobCategory)}</select></label></div><label>MBTI<input name="mbti" maxlength="4" value="${escapeHtml(p.mbti || '')}" placeholder="ENFP" required></label><label>한 줄 소개<textarea name="intro" maxlength="200">${escapeHtml(p.intro || '')}</textarea></label><hr><h2>선호 조건</h2><div class="two-cols"><label>관심 성별<select name="preferredGender">${options(['MALE','FEMALE','OTHER'], preference.preferredGender)}</select></label><label>최소 나이<input name="minAge" type="number" min="19" max="99" value="${preference.minAge || 20}" required></label></div><div class="two-cols"><label>최대 나이<input name="maxAge" type="number" min="19" max="99" value="${preference.maxAge || 35}" required></label><label>추천 지역<input name="regionScope" value="${escapeHtml((preference.regionScope || ['SEOUL_MAPO']).join(','))}" required></label></div><p class="form-error" aria-live="polite"></p><button class="button" type="submit">프로필과 선호 조건 저장</button></form></section>`, 'mypage'); }
function fortuneBanner(daily) { const ticket = daily.refreshTicket || {}; return `<section class="fortune-card"><div><p class="eyebrow">${escapeHtml(daily.serviceDate || '')} · TODAY'S FORTUNE</p><h2>${escapeHtml(daily.fortune?.grade || 'GOOD')} <span>${daily.fortune?.score ?? '-'}점</span></h2><p>${escapeHtml(daily.fortune?.message || '오늘의 인연을 만나 보세요.')}</p></div><div class="ticket"><strong>새로고침권</strong><b>${ticket.status === 'AVAILABLE' ? '사용 가능' : ticket.status === 'USED' ? '사용 완료' : '미지급'}</b><small>${ticket.expiresAt ? `${displayDate(ticket.expiresAt)}까지` : '매일 오전 8시 갱신'}</small><button id="refresh-button" class="outline-button" ${ticket.status !== 'AVAILABLE' ? 'disabled' : ''}>새 카드 보기</button></div></section>`; }
function home() { const name = state.me?.profile?.displayName || state.user?.email?.split('@')[0] || '가궁이'; return layout(`<section class="home-wide"><div class="home-title"><div><p class="eyebrow">FOR YOU</p><h1>${escapeHtml(name)}님을 위한<br>오늘의 연결</h1></div><a href="#/mypage" class="text-link">마이페이지 →</a></div><div id="daily-area"><div class="loading">오늘의 운세를 여는 중이에요…</div></div><section><div class="section-title"><div><p class="eyebrow">RECOMMENDATIONS</p><h2>오늘의 추천 카드</h2></div><span id="card-count" class="muted"></span></div><div id="recommendations" class="profile-grid"><div class="loading">추천을 불러오는 중이에요…</div></div></section></section>`, 'home'); }
function cardAvatar(card, large = false) { const image = ['AI_PUBLIC', 'BLURRED_PUBLIC'].includes(card.publicImage?.type) && typeof card.publicImage.url === 'string' && /^https?:\/\//i.test(card.publicImage.url) ? card.publicImage.url : null; const color = ['peach', 'mint', 'lilac', 'sky'].includes(card.color) ? card.color : ''; return `<div class="person-image ${color} ${large ? 'large' : ''}">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(card.displayName)}의 공개 프로필" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'placeholder-icon',textContent:'✦'}))">` : '<span class="placeholder-icon" aria-label="이미지 준비 중">✦</span>'}<span class="image-label">${image ? card.publicImage.type === 'BLURRED_PUBLIC' ? '흐림 프로필' : 'AI 프로필' : '이미지 준비 중'}</span></div>`; }
function card(card) { const hearted = state.hearted.has(card.userId); const requested = state.sentRequests.some(item => item.targetUserId === card.userId); return `<article class="person-card">${cardAvatar(card)}<div class="person-info"><div class="card-name"><h3>${escapeHtml(card.displayName)} <small>${card.age}</small></h3>${card.badges?.includes('POPULAR') ? '<span class="badge">인기</span>' : ''}</div><p class="district">⌖ ${escapeHtml(card.regionLabel || '')} · ${card.heightCm || '-'}cm</p><p class="meta">${escapeHtml(card.jobCategory || '')} · ${escapeHtml(card.mbti || '')} · ${escapeHtml(card.animalFace || '')}</p><p class="reason">${escapeHtml(card.recommendReason || '오늘의 추천 조건에 맞아요.')}</p><div class="card-actions"><button class="outline-button heart-button" data-heart="${card.userId}">${hearted ? '♥ 하트 취소' : '♡ 하트'}</button><a class="small-button" href="#/cards/${card.userId}">상세</a></div>${requested ? '<small class="sent-state">채팅 요청 보냄</small>' : ''}</div></article>`; }
// 추천 목록을 거치지 않고 바로 들어오거나 새로고침하면 state.cards 가 비어 있다.
// 예전에는 그때 목업 인물을 보여줬다. 없는 사람을 진짜처럼 보여주면 안 되므로 서버에서 받는다.
function cardDetail() { return layout('<section class="page"><a class="back" href="#/home">← 추천으로 돌아가기</a><div id="card-detail" class="loading">불러오는 중…</div></section>', 'home'); }
/** 사진 한 자리. 비어 있으면 올리는 자리, 차 있으면 공개 사진과 상태를 보여준다. */
function photoSlot(image, slot) {
  if (!image) return `<article class="person-card"><div class="person-image"><span class="placeholder-icon">＋</span></div><div class="person-info"><h2>${slot}번 자리</h2><p>비어 있습니다.</p><label class="outline-button">사진 올리기<input type="file" accept="image/jpeg,image/png,image/webp" data-upload="${slot}" hidden></label></div></article>`;
  // 미리보기는 상대가 보는 그 사진이어야 한다. 원본을 띄우면 무엇이 공개되는지 알 수 없다.
  const preview = image.publicUrl ? `<img src="${escapeHtml(image.publicUrl)}" alt="${slot}번 자리 공개 사진" data-preview="${slot}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'placeholder-icon',textContent:'✦'}))">` : '<span class="placeholder-icon">✦</span>';
  const label = image.publicType === 'AI_PUBLIC' ? 'AI 사진 공개 중' : '흐림 사진 공개 중';
  const ai = { DONE: 'AI 변환 완료', FAILED: 'AI 변환 실패' }[image.generationStatus] || 'AI 변환 준비 중';
  const original = image.publicUrl ? `<button class="small-button" data-original="${slot}">원본 확인</button>` : '';
  return `<article class="person-card"><div class="person-image">${preview}<span class="image-label">${escapeHtml(label)}</span></div><div class="person-info"><h2>${slot}번 자리</h2><p>${escapeHtml(ai)}<br>${escapeHtml(displayDate(image.uploadedAt))}</p><div class="card-actions">${original}<button class="small-button" data-delete="${escapeHtml(image.imageId)}">삭제</button></div></div></article>`;
}

function inbox() { return layout(`<section class="page"><div class="section-title"><div><p class="eyebrow">INBOX</p><h1>받은 관심</h1></div><div class="tabs"><button data-tab="hearts" class="tab active">받은 하트</button><button data-tab="requests" class="tab">받은 채팅 요청</button></div></div><div id="inbox-list"><div class="loading">목록을 불러오는 중이에요…</div></div></section>`, 'inbox'); }
function chats() { return layout(`<section class="page"><div class="section-title"><div><p class="eyebrow">CHAT</p><h1>채팅방</h1></div></div><div id="room-list"><div class="loading">채팅방을 불러오는 중이에요…</div></div></section>`, 'chats'); }
function chatRoom() { return layout(`<section class="chat-page"><a class="back" href="#/chats">← 채팅 목록</a><div id="chat-header" class="chat-header loading">채팅방을 불러오는 중이에요…</div><div id="messages" class="messages"><div class="loading">메시지를 불러오는 중이에요…</div></div><form id="message-form" class="message-form"><input name="content" maxlength="1000" placeholder="메시지를 입력하세요" required><button class="button">보내기</button></form></section>`, 'chats'); }
function mypage() { return layout(`<section class="page"><div class="section-title"><div><p class="eyebrow">MY PAGE</p><h1>내 설정</h1></div><a class="text-link" href="#/profile">프로필 수정 →</a></div><article class="setting-card"><h2>내 사진</h2><p>최대 3장까지 올릴 수 있습니다. JPG·PNG·WEBP, 10MB 이하.</p><p class="form-error" id="photo-error" aria-live="polite"></p><div id="photo-slots" class="profile-grid"><p class="loading">확인 중…</p></div><p class="privacy-note">추천 카드에는 흐림 처리된 사진만 나갑니다. 원본은 상대가 채팅 요청을 수락한 뒤에만 공개됩니다.</p></article><div class="settings-grid" style="margin-top:14px"><article class="setting-card"><h2>차단 및 신고</h2><p>차단한 사용자는 추천과 상호작용에서 제외됩니다.</p><a class="outline-button" href="#/blocks">차단 목록 보기</a></article><article class="setting-card"><h2>계정</h2><p>${escapeHtml(state.user?.email || '')}</p><span class="source-pill">${escapeHtml(state.user?.role || 'USER')}</span></article></div></section>`, 'mypage'); }
function blocks() { return layout(`<section class="page"><a class="back" href="#/mypage">← 마이페이지</a><p class="eyebrow">SAFETY</p><h1>차단 목록</h1><div class="empty-state">차단한 사용자가 없습니다.</div></section>`, 'mypage'); }
function admin() { return layout(`<section class="page admin-page"><div class="section-title"><div><p class="eyebrow">ADMIN</p><h1>운영 대시보드</h1></div><span class="admin-notice">관리자 API는 현재 권한을 서버에서 다시 검증합니다.</span></div><div id="admin-dashboard" class="metric-grid"><div class="loading">운영 지표를 불러오는 중이에요…</div></div><div class="admin-columns"><section class="setting-card"><h2>사용자 관리</h2><div id="admin-users" class="loading">불러오는 중…</div></section><section class="setting-card"><h2>신고 관리</h2><div id="admin-reports" class="loading">불러오는 중…</div></section><section class="setting-card"><h2>운영 설정</h2><div id="admin-settings" class="loading">불러오는 중…</div></section></div></section>`, 'admin'); }

async function loadMe() { try { state.me = await api.me(); state.user = { ...state.user, id: state.me.id, email: state.me.email, role: state.me.role }; } catch (error) { if (error.status === 401) { setToken(null); state.user = null; } else throw error; } }
function completeLogin(result) { setToken(result.token); state.user = result.user; location.hash = result.user.role === 'ADMIN' ? '#/admin' : '#/home'; }
function bindCardActions() { document.querySelectorAll('[data-heart]').forEach(button => button.onclick = () => toggleHeart(button.dataset.heart, button)); }
async function toggleHeart(userId, button) { const removing = state.hearted.has(userId); button.disabled = true; try { await api.heart(userId, removing); removing ? state.hearted.delete(userId) : state.hearted.add(userId); button.textContent = removing ? '♡ 하트' : '♥ 하트 취소'; showNotice(removing ? '하트를 취소했어요.' : '하트를 보냈어요.'); } catch (error) { showNotice(error.message, 'error'); } finally { button.disabled = false; } }
async function refreshCards() { const button = document.querySelector('#refresh-button'); button.disabled = true; try { const refreshed = await api.refresh(); state.cards = refreshed.cards || []; state.daily.refreshTicket = { ...state.daily.refreshTicket, ...refreshed.refreshTicket }; document.querySelector('#recommendations').innerHTML = state.cards.length ? state.cards.map(card).join('') : '<div class="empty-state">새 추천 후보가 없어요. 새로고침권은 사용되지 않았어요.</div>'; document.querySelector('#daily-area').innerHTML = fortuneBanner(state.daily); bindCardActions(); document.querySelector('#refresh-button')?.addEventListener('click', refreshCards); showNotice('새 추천 카드를 불러왔어요.'); } catch (error) { showNotice(error.message, 'error'); button.disabled = false; } }
async function loadHome() { const dailySlot = document.querySelector('#daily-area'); const cardSlot = document.querySelector('#recommendations'); try { const opened = await api.openDaily(); state.daily = opened; state.cards = opened.cards || []; dailySlot.innerHTML = fortuneBanner(opened); const list = await api.recommendations(); state.cards = list.cards || state.cards; state.hearted = new Set(list.heartedUserIds || state.hearted); cardSlot.innerHTML = state.cards.length ? state.cards.map(card).join('') : '<div class="empty-state">오늘은 새 추천이 없어요. 내일 오전 8시에 다시 열려요.</div>'; document.querySelector('#card-count').textContent = `${state.cards.length}명`; bindCardActions(); document.querySelector('#refresh-button')?.addEventListener('click', refreshCards); } catch (error) { renderError(error, dailySlot); renderError(error, cardSlot); if (error.status === 401) location.hash = '#/login'; } }
function openRequestComposer(userId) { document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="request-modal"><form id="request-form" class="request-modal"><button type="button" class="modal-close" aria-label="닫기">×</button><p class="eyebrow">CHAT REQUEST</p><h2>채팅 요청 보내기</h2><label>짧은 메시지<textarea name="message" maxlength="300" placeholder="안녕하세요, 이야기를 나눠 보고 싶어요." required></textarea></label><p class="form-error" aria-live="polite"></p><button class="button" type="submit">요청 보내기</button></form></div>`); const modal = document.querySelector('#request-modal'); modal.querySelector('.modal-close').onclick = () => modal.remove(); modal.onclick = event => { if (event.target === modal) modal.remove(); }; modal.querySelector('#request-form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; try { await api.sendChatRequest(userId, new FormData(form).get('message')); state.sentRequests.push({ targetUserId: userId }); modal.remove(); showNotice('채팅 요청을 보냈어요.'); } catch (error) { form.querySelector('.form-error').textContent = error.message; } }; }
/** 보낸 요청의 상태를 버튼 하나로 보여준다. 무시는 서버가 PENDING 으로 가려 주므로 그대로 쓴다. */
const requestButton = (status, id) => ({
  PENDING: '<button class="button" disabled>요청을 보냈어요</button>',
  ACCEPTED: '<a class="button" href="#/chats">채팅방으로 가기</a>',
  REJECTED: '<button class="button" disabled>요청이 거절됐어요</button>',
}[status] || `<button class="button" id="request-chat" data-user="${id}">채팅 요청하기</button>`);

async function loadCardDetail(id) {
  const target = document.querySelector('#card-detail');
  if (!target) return;
  try {
    const { card, hearted, chatRequestStatus } = await api.cardDetail(id);
    // 하트 여부는 서버가 알려준 값을 기준으로 둔다. 목록 화면의 표시도 여기에 맞춘다.
    hearted ? state.hearted.add(card.userId) : state.hearted.delete(card.userId);
    target.className = 'detail-page';
    target.innerHTML = `${cardAvatar(card, true)}<div class="detail-copy"><p class="eyebrow">RECOMMENDATION</p><h1>${escapeHtml(card.displayName)} <em>${card.age}</em></h1><p class="detail-meta">${escapeHtml(card.regionLabel)} · ${card.heightCm}cm · ${escapeHtml(card.jobCategory)} · ${escapeHtml(card.mbti)}</p>${card.badges?.includes('POPULAR') ? '<span class="badge">인기 배지</span>' : ''}<section class="reason-box"><strong>오늘 이 카드를 추천한 이유</strong><p>${escapeHtml(card.recommendReason || '선호 조건과 일치해요.')}</p></section><div class="detail-actions"><button class="outline-button heart-button" data-heart="${card.userId}">${hearted ? '♥ 하트 취소' : '♡ 하트'}</button>${requestButton(chatRequestStatus, card.userId)}</div><p class="privacy-note">실제 사진과 상세 프로필은 상대가 채팅 요청을 수락한 뒤에만 공개됩니다.</p></div>`;
    target.querySelector('[data-heart]')?.addEventListener('click', event => toggleHeart(card.userId, event.currentTarget));
    target.querySelector('#request-chat')?.addEventListener('click', () => openRequestComposer(card.userId));
  } catch (error) {
    target.className = 'status-card error';
    target.innerHTML = `<strong>${escapeHtml(error.message)}</strong><p><a href="#/home">홈으로 돌아가기</a></p>`;
  }
}
async function loadInbox(kind) { const slot = document.querySelector('#inbox-list'); try { const result = kind === 'hearts' ? await api.receivedHearts() : await api.chatRequests('received'); const items = result.items || []; slot.innerHTML = items.length ? items.map(item => { const partner = item.sender || item.partner; return `<article class="list-card">${cardAvatar(partner)}<div><h2>${escapeHtml(partner.displayName)} <small>${partner.age}</small></h2><p>${escapeHtml(item.message || partner.recommendReason || '나에게 관심을 보냈어요.')}</p>${kind === 'hearts' ? `<button class="button request-from-heart" data-user="${partner.userId}">채팅 요청하기</button>` : `<div class="inline-actions"><button class="button accept-request" data-request="${item.requestId}">수락</button><button class="outline-button reject-request" data-request="${item.requestId}">거절</button></div>`}</div></article>`; }).join('') : '<div class="empty-state">아직 받은 항목이 없어요.</div>'; if (kind === 'hearts') slot.querySelectorAll('.request-from-heart').forEach(button => button.onclick = () => api.sendChatRequest(button.dataset.user, '하트를 보고 채팅을 요청했어요.').then(() => showNotice('채팅 요청을 보냈어요.')).catch(error => showNotice(error.message, 'error'))); else { slot.querySelectorAll('.accept-request').forEach(button => button.onclick = () => resolveRequest(button.dataset.request, 'accept')); slot.querySelectorAll('.reject-request').forEach(button => button.onclick = () => resolveRequest(button.dataset.request, 'reject')); } } catch (error) { renderError(error, slot); } document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => { document.querySelectorAll('[data-tab]').forEach(tab => tab.classList.toggle('active', tab === button)); loadInbox(button.dataset.tab); }); }
async function resolveRequest(id, action) { try { const result = await api.resolveRequest(id, action); if (action === 'accept') { showNotice('수락했어요. 채팅방에서 서로의 프로필을 확인하세요.'); location.hash = `#/chats/${result.chatRoom?.roomId || result.roomId}`; } else { showNotice('요청을 거절했어요.'); loadInbox('requests'); } } catch (error) { showNotice(error.message, 'error'); } }
async function loadRooms() { const slot = document.querySelector('#room-list'); try { const result = await api.rooms(); const items = result.items || []; slot.innerHTML = items.length ? items.map(room => `<a class="room-card" href="#/chats/${room.roomId}">${cardAvatar(room.partner)}<div><h2>${escapeHtml(room.partner?.displayName || '상대')}</h2><p>${room.lastMessage ? escapeHtml(room.lastMessage.preview) : '수락된 채팅방 · 상세 프로필은 이 방에서만 공개됩니다.'}</p>${room.lastMessage ? `<small>${displayDate(room.lastMessage.sentAt)}</small>` : ''}</div>${room.unreadCount > 0 ? `<span class="badge">${room.unreadCount}</span>` : '<span>→</span>'}</a>`).join('') : '<div class="empty-state">열린 채팅방이 없어요. 채팅 요청이 수락되면 이곳에 표시돼요.</div>'; } catch (error) { renderError(error, slot); } }
async function loadRoom(id) { const header = document.querySelector('#chat-header'); const messageSlot = document.querySelector('#messages'); try { const room = await api.room(id); const partner = room.revealedProfile || room.partner || {}; header.className = 'chat-header'; header.innerHTML = `<div><h2>${escapeHtml(partner.displayName || '상대')}</h2><p>${escapeHtml(partner.intro || '채팅 요청 수락 후 공개된 프로필입니다.')}</p><span class="privacy-note">실제 사진 URL은 이 채팅방 참여자에게만 일시적으로 제공됩니다.</span></div><button id="block-user" class="outline-button" data-user="${partner.userId}">차단</button>`; document.querySelector('#block-user')?.addEventListener('click', () => api.block(partner.userId).then(() => { showNotice('차단했어요. 신규 메시지를 보낼 수 없습니다.'); location.hash = '#/chats'; }).catch(error => showNotice(error.message, 'error'))); const messages = await api.messages(id); messageSlot.innerHTML = (messages.items || []).map(message => `<div class="message ${String(message.senderId) === String(state.user?.id) ? 'mine' : ''}"><p>${escapeHtml(message.body)}</p><small>${displayDate(message.sentAt)}</small></div>`).join('') || '<div class="empty-state">첫 메시지를 보내 보세요.</div>'; document.querySelector('#message-form').onsubmit = async event => { event.preventDefault(); const input = event.currentTarget.elements.content; try { const message = await api.sendMessage(id, input.value); messageSlot.querySelector('.empty-state')?.remove(); messageSlot.insertAdjacentHTML('beforeend', `<div class="message mine"><p>${escapeHtml(message.body)}</p><small>${displayDate(message.sentAt)}</small></div>`); input.value = ''; messageSlot.scrollTop = messageSlot.scrollHeight; } catch (error) { showNotice(error.message, 'error'); } }; } catch (error) { renderError(error, header); renderError(error, messageSlot); } }
async function loadImages() {
  const target = document.querySelector('#photo-slots');
  if (!target) return;
  try {
    state.images = (await api.images()).images || [];
    const bySlot = new Map(state.images.map(image => [image.slot, image]));
    target.innerHTML = [1, 2, 3].map(slot => photoSlot(bySlot.get(slot), slot)).join('');
    bindPhotoSlots();
  } catch (error) { renderError(error, target); }
}

function bindPhotoSlots() {
  const errorSlot = document.querySelector('#photo-error');
  const report = message => { if (errorSlot) errorSlot.textContent = message; };

  document.querySelectorAll('[data-upload]').forEach(input => input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    report('');
    input.disabled = true;
    try { await api.uploadImage(file, input.dataset.upload); showNotice('사진을 올렸어요.'); await loadImages(); }
    catch (error) { report(error.message); input.disabled = false; input.value = ''; }
  });

  // 지우면 원본·흐림·AI 가 함께 사라진다. 되돌릴 수 없으니 한 번 더 누르게 한다.
  document.querySelectorAll('[data-delete]').forEach(button => button.onclick = async () => {
    if (button.dataset.sure !== 'yes') { button.dataset.sure = 'yes'; button.textContent = '정말 지울까요?'; return; }
    report('');
    button.disabled = true;
    try { await api.deleteImage(button.dataset.delete); showNotice('사진을 지웠어요.'); await loadImages(); }
    catch (error) { report(error.message); button.disabled = false; }
  });

  // 원본 서명 URL 은 60초면 만료된다. 미리 받아 두지 않고 누를 때 새로 받고, 잠깐 보여준 뒤 되돌린다.
  document.querySelectorAll('[data-original]').forEach(button => button.onclick = async () => {
    const slot = Number(button.dataset.original);
    const preview = document.querySelector(`[data-preview="${slot}"]`);
    if (!preview) return;
    report('');
    button.disabled = true;
    try {
      const fresh = ((await api.images()).images || []).find(image => image.slot === slot);
      if (!fresh?.originalUrl) { report('원본을 불러오지 못했습니다.'); button.disabled = false; return; }
      const shown = preview.src;
      preview.src = fresh.originalUrl;
      button.textContent = '원본 보는 중';
      setTimeout(() => { preview.src = shown; button.textContent = '원본 확인'; button.disabled = false; }, 20000);
    } catch (error) { report(error.message); button.disabled = false; }
  });
}
async function loadAdmin() { const slots = { dashboard: document.querySelector('#admin-dashboard'), users: document.querySelector('#admin-users'), reports: document.querySelector('#admin-reports'), settings: document.querySelector('#admin-settings') }; try { const [dashboard, users, reports, settings] = await Promise.all([api.admin('dashboard'), api.admin('users'), api.admin('reports'), api.admin('settings')]); slots.dashboard.innerHTML = [['가입', dashboard.signups], ['운세 열람', dashboard.fortuneOpens], ['하트', dashboard.hearts], ['채팅 요청', dashboard.chatRequests], ['대기 신고', dashboard.reportsPending], ['새로고침 잔여', dashboard.refreshInventory?.remaining]].map(([label, value]) => `<article class="metric"><span>${label}</span><b>${value ?? '-'}</b></article>`).join(''); slots.users.innerHTML = (users.items || []).map(user => `<div class="admin-row"><b>${escapeHtml(user.displayName || user.email)}</b><span>${escapeHtml(user.status)}</span><button class="outline-button" data-report-user="${user.userId}">신고</button></div>`).join('') || '<p class="muted">사용자가 없습니다.</p>'; slots.reports.innerHTML = (reports.items || []).map(report => `<div class="admin-row"><b>${escapeHtml(report.reasonCode)}</b><span>${escapeHtml(report.status)}</span><small>${escapeHtml(report.detail || '')}</small></div>`).join('') || '<p class="muted">대기 신고가 없습니다.</p>'; slots.settings.innerHTML = `<p>인기 배지: 하트 ${settings.badge?.popularMinUniqueHearts ?? '-'} · 요청 ${settings.badge?.popularMinUniqueChatRequests ?? '-'}</p><p>다음 날 새로고침권: ${settings.dailyRefresh?.nextTotal ?? '-'}개</p>`; document.querySelectorAll('[data-report-user]').forEach(button => button.onclick = () => api.report({ targetType: 'USER', targetId: button.dataset.reportUser, reasonCode: 'OTHER', detail: '관리자 화면 목업 신고' }).then(() => showNotice('신고가 접수되었습니다.')).catch(error => showNotice(error.message, 'error'))); } catch (error) { Object.values(slots).forEach(slot => renderError(error, slot)); if (error.status === 403) showNotice('관리자 권한이 필요합니다.', 'error'); } }

function bind(route) {
  document.querySelector('#logout')?.addEventListener('click', async () => { try { await api.logout(); setToken(null); state.user = null; state.me = null; location.hash = '#/'; } catch (error) { showNotice(error.message, 'error'); } });
  const loginForm = document.querySelector('#login-form');
  if (loginForm) { loginForm.onsubmit = async event => { event.preventDefault(); const errorSlot = loginForm.querySelector('.form-error'); errorSlot.textContent = ''; try { completeLogin(await api.login(new FormData(loginForm).get('email'), new FormData(loginForm).get('password'))); } catch (error) { errorSlot.textContent = error.message; } }; api.testAccounts().then(accounts => { const target = document.querySelector('#test-accounts'); if (!target) return; target.innerHTML = accounts.map(account => `<button class="test-account" data-account="${account.accountId}">${escapeHtml(account.displayName || account.email)} <small>${escapeHtml(account.role)}</small></button>`).join(''); target.querySelectorAll('[data-account]').forEach(button => button.onclick = async () => { try { completeLogin(await api.testLogin(button.dataset.account)); } catch (error) { showNotice(error.message, 'error'); } }); }).catch(() => document.querySelector('.test-login')?.remove()); }
  const signupForm = document.querySelector('#signup-form');
  if (signupForm) signupForm.onsubmit = async event => { event.preventDefault(); const errorSlot = signupForm.querySelector('.form-error'); try { completeLogin(await api.register({ email: new FormData(signupForm).get('email'), password: new FormData(signupForm).get('password'), adultVerified: true })); location.hash = '#/profile'; } catch (error) { errorSlot.textContent = error.message; } };
  const profileForm = document.querySelector('#profile-form');
  if (profileForm) profileForm.onsubmit = async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(profileForm)); const errorSlot = profileForm.querySelector('.form-error'); if (Number(data.minAge) > Number(data.maxAge)) { errorSlot.textContent = '최소 나이는 최대 나이보다 클 수 없습니다.'; return; } try { await api.saveProfile({ displayName: data.displayName, birthDate: data.birthDate, gender: data.gender, regionCode: data.regionCode, heightCm: Number(data.heightCm), jobCategory: data.jobCategory, mbti: data.mbti.toUpperCase(), intro: data.intro || null }); await api.savePreferences({ preferredGender: data.preferredGender, minAge: Number(data.minAge), maxAge: Number(data.maxAge), regionScope: data.regionScope.split(',').map(item => item.trim()).filter(Boolean), energyType: 'ANY', smokingStatus: 'ANY', tattooStatus: 'ANY', militaryService: 'ANY' }); await loadMe(); showNotice('프로필과 선호 조건을 저장했어요.'); location.hash = '#/home'; } catch (error) { errorSlot.textContent = error.message; } };
  if (route === '/home') loadHome(); if (route.startsWith('/cards/')) loadCardDetail(route.split('/').pop()); if (route === '/inbox') loadInbox('hearts'); if (route === '/chats') loadRooms(); if (route.startsWith('/chats/')) loadRoom(route.split('/').pop()); if (route === '/mypage') loadImages(); if (route === '/admin') loadAdmin();
}
async function router() { const route = location.hash.replace('#', '') || '/'; const protectedRoute = !['/', '/login', '/signup'].includes(route); if (protectedRoute && !state.user && !state.token) { location.hash = '#/login'; return; } // 목업이 없으니 /me 가 실패하면 화면이 빈 채로 남는다. 왜 안 되는지는 보여 줘야 한다.
  if (state.token && !state.user) {
    try { await loadMe(); }
    catch (error) {
      document.querySelector('#app').innerHTML = layout(`<section class="page"><div class="status-card error"><strong>${escapeHtml(error.message)}</strong><p>잠시 후 다시 시도해 주세요.</p></div></section>`);
      return;
    }
  } if (protectedRoute && !state.user) { location.hash = '#/login'; return; } if (route === '/admin' && state.user?.role !== 'ADMIN') { document.querySelector('#app').innerHTML = layout('<section class="page"><div class="status-card error"><strong>403 접근 권한 없음</strong><p>관리자 계정으로 로그인해야 합니다.</p></div></section>'); return; } const pages = { '/': landing, '/login': login, '/signup': signup, '/profile': profile, '/home': home, '/inbox': inbox, '/chats': chats, '/mypage': mypage, '/blocks': blocks, '/admin': admin }; document.querySelector('#app').innerHTML = route.startsWith('/cards/') ? cardDetail() : route.startsWith('/chats/') ? chatRoom() : (pages[route] || landing)(); bind(route); renderNotices(); window.scrollTo(0, 0); }
window.addEventListener('hashchange', router);
router();
