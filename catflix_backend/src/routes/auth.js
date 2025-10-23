const express = require('express');
const config = require('../config');

const router = express.Router();

function renderLogin(errorMessage = '') {
  return `
      <!doctype html>
      <html>
      <head>
        <title>Catflix Login</title>
        <style>
          body { background: #141414; color: #fff; margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: Arial, sans-serif; }
          .login-box { background: #000; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.7); width: 100%; max-width: 360px; text-align: center; }
          .login-box h1 { color: #e50914; margin-bottom: 20px; }
          .login-box input { width: 100%; padding: 12px; margin-bottom: 20px; border: none; border-radius: 4px; background: #333; color: #fff; }
          .login-box button { width: 100%; padding: 12px; border: none; border-radius: 4px; background: #e50914; color: #fff; font-size: 16px; cursor: pointer; }
          .error { color: #e87c03; margin-bottom: 16px; }
        </style>
      </head>
      <body>
        <div class="login-box">
          <h1>Catflix</h1>
          ${errorMessage ? `<div class="error">${errorMessage}</div>` : ''}
          <form method="POST">
            <input type="password" name="password" placeholder="Password" autofocus required />
            <button type="submit">Login</button>
          </form>
        </div>
      </body>
      </html>
  `;
}

router.get('/login', (_req, res) => {
  res.send(renderLogin());
});

router.post('/login', (req, res) => {
  if ((req.body.password || '').trim() === config.PASSWORD) {
    res.cookie('loggedIn', '1', { httpOnly: true });
    return res.redirect('/');
  }
  res.send(renderLogin('Wrong password. Please try again.'));
});

router.post('/logout', (req, res) => {
  res.clearCookie('loggedIn', { path: '/' });
  res.sendStatus(204);
});

module.exports = router;
