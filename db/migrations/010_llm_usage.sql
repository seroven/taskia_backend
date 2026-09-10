-- Migration 010: registro de llamadas a Gemini (tokens / costo por alumno)
USE taskia;

CREATE TABLE IF NOT EXISTS llm_usage (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  kind ENUM(
    'task_tutor',
    'mission_tutor',
    'transcribe',
    'challenge_generate',
    'challenge_grade'
  ) NOT NULL,
  model VARCHAR(80) NOT NULL,
  prompt_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  total_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_llm_usage_user_created (user_id, created_at),
  KEY idx_llm_usage_kind_created (kind, created_at),
  CONSTRAINT fk_llm_usage_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
