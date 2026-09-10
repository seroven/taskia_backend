-- Migration 009: courses belong to a student; users can be paused
-- Idempotente: si un paso ya corrió (p. ej. fallo a mitad), se puede reaplicar.
USE taskia;

SET @db := DATABASE();

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_active'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER `role`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'courses' AND COLUMN_NAME = 'user_id'
    ),
    'SELECT 1',
    'ALTER TABLE courses ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'courses' AND INDEX_NAME = 'uq_courses_name'
    ),
    'ALTER TABLE courses DROP INDEX uq_courses_name',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

DROP TEMPORARY TABLE IF EXISTS tmp_course_catalog;
CREATE TEMPORARY TABLE tmp_course_catalog (
  old_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  is_active TINYINT(1) NOT NULL,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO tmp_course_catalog (old_id, name, is_active, created_at)
SELECT id, name, is_active, created_at
FROM courses
WHERE user_id IS NULL;

INSERT INTO courses (user_id, name, is_active, created_at)
SELECT u.id, t.name, t.is_active, t.created_at
FROM users u
CROSS JOIN tmp_course_catalog t
WHERE NOT EXISTS (
  SELECT 1 FROM courses c
  WHERE c.user_id = u.id
    AND c.name COLLATE utf8mb4_unicode_ci = t.name COLLATE utf8mb4_unicode_ci
);

UPDATE tasks t
INNER JOIN tmp_course_catalog old_c ON old_c.old_id = t.course_id
INNER JOIN courses new_c
  ON new_c.user_id = t.user_id
 AND new_c.name COLLATE utf8mb4_unicode_ci = old_c.name COLLATE utf8mb4_unicode_ci
SET t.course_id = new_c.id;

UPDATE study_world_courses swc
INNER JOIN study_worlds w ON w.id = swc.world_id
INNER JOIN tmp_course_catalog old_c ON old_c.old_id = swc.course_id
INNER JOIN courses new_c
  ON new_c.user_id = w.user_id
 AND new_c.name COLLATE utf8mb4_unicode_ci = old_c.name COLLATE utf8mb4_unicode_ci
SET swc.course_id = new_c.id;

UPDATE study_missions m
INNER JOIN study_worlds w ON w.id = m.world_id
INNER JOIN tmp_course_catalog old_c ON old_c.old_id = m.course_id
INNER JOIN courses new_c
  ON new_c.user_id = w.user_id
 AND new_c.name COLLATE utf8mb4_unicode_ci = old_c.name COLLATE utf8mb4_unicode_ci
SET m.course_id = new_c.id;

UPDATE study_challenges ch
INNER JOIN tmp_course_catalog old_c ON old_c.old_id = ch.course_id
INNER JOIN courses new_c
  ON new_c.user_id = ch.user_id
 AND new_c.name COLLATE utf8mb4_unicode_ci = old_c.name COLLATE utf8mb4_unicode_ci
SET ch.course_id = new_c.id
WHERE ch.course_id IS NOT NULL;

DELETE FROM courses WHERE user_id IS NULL;
DROP TEMPORARY TABLE IF EXISTS tmp_course_catalog;

ALTER TABLE courses
  MODIFY user_id BIGINT UNSIGNED NOT NULL;

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'courses' AND INDEX_NAME = 'uq_courses_user_name'
    ),
    'SELECT 1',
    'ALTER TABLE courses ADD UNIQUE KEY uq_courses_user_name (user_id, name)'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'courses' AND INDEX_NAME = 'idx_courses_user_id'
    ),
    'SELECT 1',
    'ALTER TABLE courses ADD KEY idx_courses_user_id (user_id)'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'courses' AND CONSTRAINT_NAME = 'fk_courses_user'
    ),
    'SELECT 1',
    'ALTER TABLE courses ADD CONSTRAINT fk_courses_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
