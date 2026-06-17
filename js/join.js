document.addEventListener('DOMContentLoaded', async () => {
  const usernameInput     = document.getElementById('usernameInput');
  const avatarBtn         = document.getElementById('avatarBtn');
  const avatarFileInput   = document.getElementById('avatarFileInput');
  const avatarImg         = document.getElementById('avatarImg');
  const avatarPlaceholder = document.getElementById('avatarPlaceholder');
  const joinBtn           = document.getElementById('joinBtn');
  const roomCodeDisplay   = document.getElementById('roomCodeDisplay');
  const invalidMsg        = document.getElementById('invalidMsg');

  const roomId = window.location.hash.slice(1).toUpperCase();

  if (!roomId) {
    roomCodeDisplay.textContent = '------';
    invalidMsg.classList.remove('hidden');
    joinBtn.disabled = true;
  } else {
    roomCodeDisplay.textContent = roomId;
  }

  // Restore saved profile
  const profile = (await dbGet('user_profile')) || { username: '', image: null };
  usernameInput.value = profile.username;
  if (profile.image) showAvatarImage(profile.image);

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

  // --- Join ---

  joinBtn.addEventListener('click', async () => {
    if (!roomId) return;
    profile.username = usernameInput.value.trim() || 'Joueur';
    await dbSet('user_profile', profile);
    await dbSet('game_session', { role: 'client', roomId });
    window.location.href = `room.html#${roomId}`;
  });

  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });
});
