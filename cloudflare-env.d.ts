declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BOOTSTRAP_ADMIN_EMAIL?: string;
    BUCKET?: R2Bucket;
    AUTH_MODE?: 'wechat';
    WECHAT_APP_ID?: string;
    WECHAT_APP_SECRET?: string;
  }
}
