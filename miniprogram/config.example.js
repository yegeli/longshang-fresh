// Copy these non-secret settings into config.js after deploying the dedicated
// WeChat API and adding its HTTPS origin to the WeChat request/download domains.
// Never put AppSecret, session_key or a Sites service bearer in the client.
module.exports = { mode: 'cloud', apiBase: 'https://api.example.com', requestTimeout: 15000 };
