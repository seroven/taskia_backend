-- Migration 002: difficulty levels + daily/project task kind
-- Run against database `taskia` (one statement block at a time if needed)

USE taskia;

CREATE TABLE IF NOT EXISTS difficulties (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(50) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_difficulties_code (code),
  UNIQUE KEY uq_difficulties_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO difficulties (code, name, sort_order) VALUES
  ('low', 'Bajo', 1),
  ('medium', 'Medio', 2),
  ('high', 'Alto', 3) AS new_rows
ON DUPLICATE KEY UPDATE
  name = new_rows.name,
  sort_order = new_rows.sort_order;

-- New columns (fail if already applied — that means migration is done)
ALTER TABLE tasks
  ADD COLUMN difficulty_id BIGINT UNSIGNED NULL AFTER course_id,
  ADD COLUMN task_kind ENUM('daily', 'project') NOT NULL DEFAULT 'daily' AFTER description;

UPDATE tasks t
SET t.difficulty_id = (
  SELECT d.id FROM difficulties d WHERE d.code = 'medium' LIMIT 1
)
WHERE t.difficulty_id IS NULL;

ALTER TABLE tasks
  MODIFY COLUMN difficulty_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE tasks
  ADD KEY idx_tasks_difficulty_id (difficulty_id),
  ADD KEY idx_tasks_task_kind (task_kind),
  ADD CONSTRAINT fk_tasks_difficulty
    FOREIGN KEY (difficulty_id) REFERENCES difficulties (id)
    ON DELETE RESTRICT ON UPDATE CASCADE;
