document.addEventListener('DOMContentLoaded', async () => {
  const usernameInput   = document.getElementById('usernameInput');
  const avatarBtn       = document.getElementById('avatarBtn');
  const avatarFileInput = document.getElementById('avatarFileInput');
  const avatarImg       = document.getElementById('avatarImg');
  const avatarPlaceholder = document.getElementById('avatarPlaceholder');
  const createBtn       = document.getElementById('createBtn');
  const joinBtn         = document.getElementById('joinBtn');
  const joinModal       = document.getElementById('joinModal');
  const roomCodeInput   = document.getElementById('roomCodeInput');
  const cancelJoinBtn   = document.getElementById('cancelJoinBtn');
  const confirmJoinBtn  = document.getElementById('confirmJoinBtn');

  // Restore saved profile
  const profile = (await dbGet('user_profile')) || { username: '', image: null };
  usernameInput.value = profile.username;
  if (profile.image) showAvatarImage(profile.image);

  // Pre-fill join modal if coming from a shared room link
  const joinPreset = new URLSearchParams(window.location.search).get('join');
  if (joinPreset) {
    roomCodeInput.value = joinPreset.toUpperCase();
    openJoinModal();
  }

  // --- Avatar handling ---

  avatarBtn.addEventListener('click', () => avatarFileInput.click());

  avatarFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      profile.image = ev.target.result;
      showAvatarImage(profile.image);
    };
    reader.readAsDataURL(file);
  });

  function showAvatarImage(src) {
    avatarImg.src = src;
    avatarImg.classList.remove('hidden');
    avatarPlaceholder.classList.add('hidden');
  }

  // --- Create room ---

  createBtn.addEventListener('click', async () => {
    const roomId = generateRoomCode();
    await persistProfileAndNavigate('host', roomId);
  });

  // --- Join room ---

  joinBtn.addEventListener('click', openJoinModal);
  cancelJoinBtn.addEventListener('click', closeJoinModal);

  joinModal.addEventListener('click', (e) => {
    if (e.target === joinModal) closeJoinModal();
  });

  roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmJoin();
  });

  confirmJoinBtn.addEventListener('click', confirmJoin);

  async function confirmJoin() {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) { roomCodeInput.focus(); return; }
    await persistProfileAndNavigate('client', code);
  }

  // --- Helpers ---

  function openJoinModal() {
    joinModal.classList.remove('hidden');
    roomCodeInput.focus();
  }

  function closeJoinModal() {
    joinModal.classList.add('hidden');
  }

  async function persistProfileAndNavigate(role, roomId) {
    profile.username = usernameInput.value.trim() || 'Joueur';
    await dbSet('user_profile', profile);
    await dbSet('game_session', { role, roomId });
    window.location.href = `room.html#${roomId}`;
  }
});

function generateRoomCode() {
  // Unambiguous characters (no I/O/0/1)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
