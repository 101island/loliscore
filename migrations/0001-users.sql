CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    qq TEXT,
    avatar TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
