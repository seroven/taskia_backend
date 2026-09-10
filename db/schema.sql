-- Taskia schema
-- MySQL 8+
--
-- Si tu cliente SQL falla con error 1064 cerca del 2.º CREATE:
-- ejecuta cada bloque por separado (uno por uno), o desde taskia_backend:
--   npm run db:setup
--   npm run db:migrate
--
-- Nota: `role` va entre backticks porque es palabra reservada en MySQL 8.

CREATE DATABASE IF NOT EXISTS taskia
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE taskia;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  `role` ENUM('user', 'admin') NOT NULL DEFAULT 'user',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Courses (per student; admin assigns them)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_courses_user_name (user_id, name),
  KEY idx_courses_user_id (user_id),
  CONSTRAINT fk_courses_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Difficulties (Bajo / Medio / Alto)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Tasks (Kanban)
-- status: pending -> in_progress -> studying -> done
-- task_kind: daily (due today) | project (custom due date)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  course_id BIGINT UNSIGNED NOT NULL,
  difficulty_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  task_kind ENUM('daily', 'project') NOT NULL DEFAULT 'daily',
  status ENUM('pending', 'in_progress', 'studying', 'done') NOT NULL DEFAULT 'pending',
  board_order INT NOT NULL DEFAULT 0,
  study_passed TINYINT(1) NOT NULL DEFAULT 0,
  uses_board TINYINT(1) NOT NULL DEFAULT 0,
  study_mode_chosen TINYINT(1) NOT NULL DEFAULT 0,
  due_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tasks_user_id (user_id),
  KEY idx_tasks_course_id (course_id),
  KEY idx_tasks_difficulty_id (difficulty_id),
  KEY idx_tasks_status (status),
  KEY idx_tasks_task_kind (task_kind),
  KEY idx_tasks_due_date (due_date),
  KEY idx_tasks_created_at (created_at),
  KEY idx_tasks_user_status_order (user_id, status, board_order),
  CONSTRAINT fk_tasks_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_tasks_course
    FOREIGN KEY (course_id) REFERENCES courses (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_tasks_difficulty
    FOREIGN KEY (difficulty_id) REFERENCES difficulties (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Study sessions (rolling context summary for Gemini — not full chat history)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Study chat messages (UI history; Gemini uses context_summary instead)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  role ENUM('user', 'assistant') NOT NULL,
  content TEXT NOT NULL,
  from_voice TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_study_messages_task_created (task_id, created_at),
  CONSTRAINT fk_study_messages_task
    FOREIGN KEY (task_id) REFERENCES tasks (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Study boards (Excalidraw scene per task)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_boards (
  task_id BIGINT UNSIGNED NOT NULL,
  board_json LONGTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id),
  CONSTRAINT fk_study_boards_task
    FOREIGN KEY (task_id) REFERENCES tasks (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- User study memory (cross-task tutor memory; rolling summary)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_study_memory (
  user_id BIGINT UNSIGNED NOT NULL,
  memory_summary TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_study_memory_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Mundos de estudio (aprendizaje deliberado; separado del Kanban de tareas)
-- UI: Mundo → Materia → Misión; Desafíos Calentamiento/Aventura/Jefe final
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
  from_voice TINYINT(1) NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS study_challenge_presets (
  scope ENUM('mission', 'course', 'world') NOT NULL,
  difficulty ENUM('warm', 'quest', 'boss') NOT NULL,
  question_count INT NOT NULL,
  label VARCHAR(40) NOT NULL,
  PRIMARY KEY (scope, difficulty)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Uso de Gemini (tokens por alumno y tipo de llamada)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Seed: difficulties
-- ---------------------------------------------------------------------------
INSERT INTO difficulties (code, name, sort_order) VALUES
  ('low', 'Bajo', 1),
  ('medium', 'Medio', 2),
  ('high', 'Alto', 3) AS new_difficulties
ON DUPLICATE KEY UPDATE
  name = new_difficulties.name,
  sort_order = new_difficulties.sort_order;

-- ---------------------------------------------------------------------------
-- Seed: challenge presets (Calentamiento / Aventura / Jefe final)
-- ---------------------------------------------------------------------------
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
