DROP TABLE IF EXISTS users;

CREATE TABLE users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    qq TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_users_username ON users(username);