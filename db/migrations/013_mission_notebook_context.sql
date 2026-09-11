-- Migration 013: relato fijo del cuaderno en misiones (sin pizarra)
USE taskia;

ALTER TABLE study_mission_sessions
  ADD COLUMN notebook_context TEXT NOT NULL DEFAULT ''
    COMMENT 'Relato fijo del tema (primer mensaje del alumno); no lo reescribe el tutor'
    AFTER context_summary;
