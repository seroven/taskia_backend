-- Migration 008: remember first-time board vs chat choice for study tasks
USE taskia;

ALTER TABLE tasks
  ADD COLUMN study_mode_chosen TINYINT(1) NOT NULL DEFAULT 0
    AFTER uses_board;

-- Si ya estudiaron, no volver a preguntar.
UPDATE tasks t
INNER JOIN study_sessions s ON s.task_id = t.id
SET t.study_mode_chosen = 1;
