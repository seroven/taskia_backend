-- Migration 003: study chat + rolling context summary per task
-- Run: mysql ... < db/migrations/003_study_session.sql
-- Or: node db/migrate.mjs (schema.sql also includes these tables)

USE taskia;

CREATE TABLE IF NOT EXISTS study_sessions (
  task_id BIGINT UNSIGNED NOT NULL,
  tutor_phase ENUM('understanding', 'practicing', 'reviewing') NOT NULL DEFAULT 'understanding',
  topic_summary TEXT NOT NULL,
  context_summary TEXT NOT NULL,
  hints_level INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id),
  CONSTRAINT fk_study_sessions_task
    FOREIGN KEY (task_id) REFERENCES tasks (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS study_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  role ENUM('user', 'assistant') NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_study_messages_task_created (task_id, created_at),
  CONSTRAINT fk_study_messages_task
    FOREIGN KEY (task_id) REFERENCES tasks (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
