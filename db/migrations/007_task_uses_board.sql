-- Migration 007: optional Excalidraw board on Kanban study tasks
USE taskia;

ALTER TABLE tasks
  ADD COLUMN uses_board TINYINT(1) NOT NULL DEFAULT 1
    AFTER study_passed;
