-- Migration 006: Mundos de estudio (misiones + desafíos)
-- UI: Mundo → Materia → Misión; Desafíos (Calentamiento / Aventura / Jefe final)
USE taskia;

-- ---------------------------------------------------------------------------
-- Mundos (grupo de estudio por usuario)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_worlds (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(120) NOT NULL,
  description TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_study_worlds_user (user_id),
  CONSTRAINT fk_study_worlds_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Materias dentro de un mundo (reutiliza `courses`)
CREATE TABLE IF NOT EXISTS study_world_courses (
  world_id BIGINT UNSIGNED NOT NULL,
  course_id BIGINT UNSIGNED NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (world_id, course_id),
  KEY idx_study_world_courses_course (course_id),
  CONSTRAINT fk_study_world_courses_world
    FOREIGN KEY (world_id) REFERENCES study_worlds (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_study_world_courses_course
    FOREIGN KEY (course_id) REFERENCES courses (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Misiones (temas)
-- status: pending (Por empezar) | studying (En marcha) | mastered (Dominado)
-- uses_board: define práctica con pizarra y tipo de preguntas en desafíos
-- source_mission_id: copia traída de otro mundo (misma materia)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_missions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  world_id BIGINT UNSIGNED NOT NULL,
  course_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  status ENUM('pending', 'studying', 'mastered') NOT NULL DEFAULT 'pending',
  uses_board TINYINT(1) NOT NULL DEFAULT 0,
  source_mission_id BIGINT UNSIGNED NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_study_missions_world_course (world_id, course_id),
  KEY idx_study_missions_status (status),
  KEY idx_study_missions_source (source_mission_id),
  CONSTRAINT fk_study_missions_world
    FOREIGN KEY (world_id) REFERENCES study_worlds (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_study_missions_course
    FOREIGN KEY (course_id) REFERENCES courses (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_study_missions_source
    FOREIGN KEY (source_mission_id) REFERENCES study_missions (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sesión de estudio de una misión (tutor guía el tema; no es el desafío)
CREATE TABLE IF NOT EXISTS study_mission_sessions (
  mission_id BIGINT UNSIGNED NOT NULL,
  tutor_phase ENUM('understanding', 'practicing', 'reviewing') NOT NULL DEFAULT 'understanding',
  topic_summary TEXT NOT NULL,
  context_summary TEXT NOT NULL,
  hints_level INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (mission_id),
  CONSTRAINT fk_study_mission_sessions_mission
    FOREIGN KEY (mission_id) REFERENCES study_missions (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS study_mission_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mission_id BIGINT UNSIGNED NOT NULL,
  role ENUM('user', 'assistant') NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_study_mission_messages_mission (mission_id, id),
  CONSTRAINT fk_study_mission_messages_mission
    FOREIGN KEY (mission_id) REFERENCES study_missions (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS study_mission_boards (
  mission_id BIGINT UNSIGNED NOT NULL,
  board_json LONGTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (mission_id),
  CONSTRAINT fk_study_mission_boards_mission
    FOREIGN KEY (mission_id) REFERENCES study_missions (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Desafíos (antes “examen”)
-- scope: mission | course | world
-- difficulty: warm (Calentamiento) | quest (Aventura) | boss (Jefe final)
-- Conteos: misión 5/8/10 · materia 10/15/20 · mundo 20/40/80
-- Cada intento regenera preguntas; el historial queda en estas tablas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_challenges (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  world_id BIGINT UNSIGNED NOT NULL,
  scope ENUM('mission', 'course', 'world') NOT NULL,
  mission_id BIGINT UNSIGNED NULL,
  course_id BIGINT UNSIGNED NULL,
  difficulty ENUM('warm', 'quest', 'boss') NOT NULL,
  question_count INT NOT NULL,
  status ENUM('in_progress', 'completed', 'abandoned') NOT NULL DEFAULT 'in_progress',
  score TINYINT UNSIGNED NULL COMMENT '0-100 cuando status=completed',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_study_challenges_user (user_id, started_at),
  KEY idx_study_challenges_world (world_id),
  KEY idx_study_challenges_mission (mission_id),
  KEY idx_study_challenges_course (course_id),
  CONSTRAINT fk_study_challenges_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_study_challenges_world
    FOREIGN KEY (world_id) REFERENCES study_worlds (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_study_challenges_mission
    FOREIGN KEY (mission_id) REFERENCES study_missions (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_study_challenges_course
    FOREIGN KEY (course_id) REFERENCES courses (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS study_challenge_questions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  challenge_id BIGINT UNSIGNED NOT NULL,
  mission_id BIGINT UNSIGNED NULL,
  sort_order INT NOT NULL DEFAULT 0,
  -- multiple_choice | short_text | fill_blank | board_prompt
  kind ENUM('multiple_choice', 'short_text', 'fill_blank', 'board_prompt') NOT NULL,
  prompt TEXT NOT NULL,
  options_json JSON NULL COMMENT 'Para multiple_choice: ["A","B","C","D"]',
  answer_key TEXT NOT NULL COMMENT 'Clave o criterio breve para autocorregir',
  requires_board TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_study_challenge_questions_challenge (challenge_id, sort_order),
  CONSTRAINT fk_study_challenge_questions_challenge
    FOREIGN KEY (challenge_id) REFERENCES study_challenges (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_study_challenge_questions_mission
    FOREIGN KEY (mission_id) REFERENCES study_missions (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS study_challenge_answers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  question_id BIGINT UNSIGNED NOT NULL,
  user_answer TEXT NULL,
  board_json LONGTEXT NULL,
  is_correct TINYINT(1) NULL,
  answered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_study_challenge_answers_question (question_id),
  CONSTRAINT fk_study_challenge_answers_question
    FOREIGN KEY (question_id) REFERENCES study_challenge_questions (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Presets de cantidad de preguntas (referencia; la app también puede hardcodear)
CREATE TABLE IF NOT EXISTS study_challenge_presets (
  scope ENUM('mission', 'course', 'world') NOT NULL,
  difficulty ENUM('warm', 'quest', 'boss') NOT NULL,
  question_count INT NOT NULL,
  label VARCHAR(40) NOT NULL,
  PRIMARY KEY (scope, difficulty)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO study_challenge_presets (scope, difficulty, question_count, label) VALUES
  ('mission', 'warm', 5, 'Calentamiento'),
  ('mission', 'quest', 8, 'Aventura'),
  ('mission', 'boss', 10, 'Jefe final'),
  ('course', 'warm', 10, 'Calentamiento'),
  ('course', 'quest', 15, 'Aventura'),
  ('course', 'boss', 20, 'Jefe final'),
  ('world', 'warm', 20, 'Calentamiento'),
  ('world', 'quest', 40, 'Aventura'),
  ('world', 'boss', 80, 'Jefe final') AS new_rows
ON DUPLICATE KEY UPDATE
  question_count = new_rows.question_count,
  label = new_rows.label;
