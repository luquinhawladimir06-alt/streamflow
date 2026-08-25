document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/user');
    const data = await res.json();

    const loginBtns = document.querySelectorAll('.discord-login-btn');
    const userProfiles = document.querySelectorAll('.user-profile-display');
    const userNames = document.querySelectorAll('.auth-user-name');
    const userAvatars = document.querySelectorAll('.auth-user-avatar');

    if (data.loggedIn && data.user) {
      // Hide login buttons, show profiles
      loginBtns.forEach(btn => btn.style.display = 'none');
      userProfiles.forEach(el => el.style.display = 'flex');

      userNames.forEach(el => el.textContent = data.user.username);
      userAvatars.forEach(el => {
        if (data.user.avatar) {
          el.src = data.user.avatar;
        } else {
          el.src = 'https://cdn.discordapp.com/embed/avatars/0.png';
        }
      });
    } else {
      // Show login buttons, hide profiles
      loginBtns.forEach(btn => btn.style.display = 'flex');
      userProfiles.forEach(el => el.style.display = 'none');
    }
  } catch (error) {
    console.error('Erro ao buscar status de login:', error);
  }
});
