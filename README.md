# Taskia — backend

API de **Taskia**: Express + TypeScript + MySQL. Sirve al frontend web (`[taskia_frontend](../taskia_frontend)`) y concentra autenticación, tareas, estudio con Gemini, mundos y el panel del adulto.

El producto es una app de estudio para **alumnos** (`role: user`) con un **adulto/admin** que crea las cuentas y sigue el progreso. No hay registro público: `POST /auth/register` responde 403.

## Qué cubre la API

### Alumno

- Login y perfil (`/auth`). La sesión es un JWT en cookie httpOnly (`taskia_token` por defecto), no un Bearer en localStorage.
- Cursos activos y catálogo de dificultades.
- Tareas: listar, crear, editar, mover de columna y reordenar. El paso a *Terminado* en dificultad alta (o desde *En estudio*) exige `study_passed` del tutor.
- Estudio de una tarea: sesión, chat con Gemini (fases comprensión / práctica / repaso), pizarra (escena JSON) y transcripción de audio.
- Mundos, cursos del mundo, misiones (crear, editar, importar), estudio de misión y desafíos generados/calificados por Gemini (`mission` | `course` | `world`).



### Administrador (`requireAdmin`)

- Dashboard (métricas, actividad, uso de Gemini).
- CRUD de alumnos (crear, editar, pausar/activar).
- Materias por alumno (crear, renombrar, archivar, importar de otro alumno).
- Ficha: overview, tareas, sesiones de estudio, árbol de mundos y detalle de un desafío.

Gemini vive en `src/services/gemini.ts` (tutor, transcripciones, generación y corrección de desafíos). El uso se registra en `llm_usage`. La pizarra cuadriculada se renderiza en el front; aquí se guarda la escena JSON y, si aplica, operaciones de dibujo (`draw_ops`).

## Cómo correrlo

1. Copia `.env.example` a `.env.development` y completa MySQL, `JWT_SECRET` y `GEMINI_API_KEY`.
2. `CORS_ORIGIN` debe ser el origen exacto del front (en local, `http://localhost:5173`).
3. Base de datos (MySQL, no SQLite):

```bash
npm install
npm run db:setup      # primera vez (schema + migraciones)
npm run db:migrate    # migraciones pendientes
npm run dev           # tsx watch + .env.development  (puerto 3001)
```


| Script                                  | Env                                                              |
| --------------------------------------- | ---------------------------------------------------------------- |
| `npm run dev`                           | `.env.development`                                               |
| `npm run dev:pd`                        | `.env.pd` (watch)                                                |
| `npm run build` / `build:pd`            | Compila a `dist/`                                                |
| `npm start`                             | `node dist/index.js` (usa el env del proceso; típico en hosting) |
| `npm run start:pd`                      | `dist/` + `.env.pd` en disco                                     |
| `npm run db:setup:pd` / `db:migrate:pd` | Igual con `.env.pd` (también hay variantes `:qa`)                |


`GET /health` responde `{ ok: true }`.

## Auth y cookies

- Cookie httpOnly, CORS con `credentials: true`.
- Local: `COOKIE_SECURE=false`, `COOKIE_SAME_SITE=lax`.
- Front y API en **orígenes distintos** (p. ej. dos `*.onrender.com`): `COOKIE_SECURE=true` y `COOKIE_SAME_SITE=none` (minúsculas). `Lax` no envía la cookie en ese caso y `/auth/me` queda en 401.

Plantillas: `.env.example`, `.env.example.qa`, `.env.example.pd`, `.env.example.production`.

Variables principales: `PORT`, `CORS_ORIGIN`, `MYSQL_*`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `COOKIE_NAME`, `COOKIE_SECURE`, `COOKIE_SAME_SITE`, `GEMINI_API_KEY`, `GEMINI_MODEL`.

En un host tipo Render, configura esas variables en el panel. `npm start` no lee `.env.pd` del repo.

## Rutas

Montadas en `src/app.ts`:


| Prefijo         | Uso                            |
| --------------- | ------------------------------ |
| `GET /health`   | Liveness                       |
| `/auth`         | Login, logout, `/me`           |
| `/courses`      | Cursos del alumno              |
| `/difficulties` | Dificultades                   |
| `/tasks`        | Tablero de tareas              |
| `/study`        | Tutor, pizarra y transcripción |
| `/worlds`       | Mundos, misiones y desafíos    |
| `/admin`        | Panel del adulto               |




## Carpetas

```
db/              schema.sql, migrate.mjs, migrations/
src/index.ts     Arranque
src/app.ts       Express, CORS, rutas
src/config/      Entorno
src/middleware/  Auth y errores
src/routes/      auth, tasks, study, worlds, admin, …
src/services/    Gemini
```

