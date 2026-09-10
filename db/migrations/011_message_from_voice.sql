-- Migration 011: marcar mensajes transcritos de audio
USE taskia;

ALTER TABLE study_messages
  ADD COLUMN from_voice TINYINT(1) NOT NULL DEFAULT 0
    AFTER content;

ALTER TABLE study_mission_messages
  ADD COLUMN from_voice TINYINT(1) NOT NULL DEFAULT 0
    AFTER content;
