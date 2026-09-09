-- Migration 005: study_passed flag (AI mastery gate for high-difficulty tasks)
USE taskia;

ALTER TABLE tasks
  ADD COLUMN study_passed TINYINT(1) NOT NULL DEFAULT 0
    AFTER board_order;
