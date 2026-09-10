-- Migration 012: dibujo del enunciado en preguntas de pizarra
USE taskia;

ALTER TABLE study_challenge_questions
  ADD COLUMN prompt_draw_ops JSON NULL
    COMMENT 'draw_ops de la IA: el problema dibujado en pizarra'
    AFTER requires_board;
