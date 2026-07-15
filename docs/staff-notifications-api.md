# Notifications API — Recipient (auth-scoped, paginated)

## `GET /api/notifications/me`

Returns notifications for the **authenticated** user only. The recipient is
derived from the JWT (`protect` middleware) — it is **never** taken from the
query string, so a caller can only read their own notifications.

### Auth
`Authorization: Bearer <jwt>` (required). Missing/invalid token → `401`.

### Query parameters
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `page` | int ≥ 1 | `1` | Page number |
| `limit` | int 1–100 | `20` | Page size; values > 100 are clamped to 100 |
| `isRead` | bool | — | `true`/`false` (also accepts `read`, `1`/`0`, `read`/`unread`) |
| `type` | string | — | e.g. `task`, `complaint`; `[A-Za-z0-9_.:-]{1,64}` |
| `priority` | enum | — | `low` \| `normal` \| `high` \| `urgent` |
| `from` | date | — | inclusive lower bound on `createdAt` (also `startDate`) |
| `to` | date | — | inclusive upper bound on `createdAt` (also `endDate`) |

Invalid params return `400` with an `errorCode`.

### Success `200`
```json
{
  "success": true,
  "data": [
    { "id": "665...", "title": "New task", "message": "Clean lobby",
      "type": "task", "priority": "high", "isRead": false,
      "createdAt": "2026-07-10T10:00:00.000Z" }
  ],
  "pagination": {
    "page": 1, "limit": 20, "total": 42, "totalPages": 3,
    "hasNext": true, "hasPrevious": false
  }
}
```

Only UI fields are returned. `from`, `toRole`, `__v`, and any internal/owner-only
values inside `meta` are excluded at the database level (projection).

### Errors
```json
{ "success": false, "message": "\"priority\" must be one of: low, normal, high, urgent", "errorCode": "INVALID_QUERY" }
```
| Status | errorCode | When |
|--------|-----------|------|
| 400 | `INVALID_QUERY` | bad/invalid query parameter |
| 401 | `UNAUTHENTICATED` | missing/invalid token |
| 500 | `INTERNAL_ERROR` | unexpected server error |

---

## Architecture
```
routes/notificationRoutes.js         GET /me → protect → controller
controllers/notificationController.js getMyNotifications (thin: parse → service → respond)
services/staffNotificationService.js  validation, auth-scoped filter, shaping, pagination (repo injected → unit-testable)
repositories/notificationRepository.js data access only: projection + pagination + count
models/Notification.js                schema + indexes
```

## Database
Composite index added for the hot recipient query
(`find({ toLoginId, read? }).sort({ createdAt: -1 })`):

```
{ toLoginId: 1, read: 1, createdAt: -1 }
```

Create it in production (where `autoIndex` is usually off):
```
node scripts/migrate_staff_notification_index.js            # create (idempotent)
node scripts/migrate_staff_notification_index.js --rollback # drop
```

## Tests
```
npm test        # node --test, no DB required (repository is mocked)
```
Covers: auth scoping (incl. rejecting client-supplied ids), pagination + limit
clamping, read/unread + type + priority + date filtering, invalid params, empty
results, and output shaping/field-hiding.

## Backward compatibility
The legacy `GET /api/notifications/` (returns a raw array, used by the owner /
super-admin / mobile panels) is **unchanged**. This endpoint is additive. New
clients should prefer `/me`, which is authenticated, scoped and paginated.
