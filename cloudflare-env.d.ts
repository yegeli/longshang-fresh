declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BOOTSTRAP_ADMIN_EMAIL?: string;
    BUCKET?: R2Bucket;
  }
}
